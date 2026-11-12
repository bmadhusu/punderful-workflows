import {
  WorkflowEntrypoint,
  WorkflowEvent,
  WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import OpenAI from "openai";

export type PublishParams = {
  punId: string;
  pun: string;
};

async function talkToLLM(baseUrl: string, pun: string) {
  console.log(`[LLM] calling ${baseUrl} for "${pun}"`);
  const response = await fetch(baseUrl + "/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messages: [
        {
          role: "system",
          content: `You help categorize puns for people to search for later.

                The user is going to give you a pun and your job is to list the most relevant categories for the pun, based on the content of the pun.

		Do not include words about pun in general, focus on what the content is about. For instance don't return "word play" or "pun" as a category.

		Return only the categories, comma separated. Do not include a preamble or introudction, just the categories.
		`,
        },
        { role: "user", content: pun },
      ],
    }),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Chat completion failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  if (data.choices[0]?.message?.content === "") {
    throw new Error("No response from LLM!");
  }
  console.log(`[LLM] "${pun}" => ${data.choices[0]?.message?.content}`);
  return data.choices[0]?.message?.content;
}

export class PublishWorkflow extends WorkflowEntrypoint<Env, PublishParams> {
  async run(event: WorkflowEvent<PublishParams>, step: WorkflowStep) {
    const { pun, punId } = event.payload;
    // step: [OPTIONAL] Moderate using OpenAI's free moderation API
    if (this.env.OPENAI_API_KEY !== undefined) {
      await step.do("content-moderation", async () => {
        const openai = new OpenAI({ apiKey: this.env.OPENAI_API_KEY });

        const moderation = await openai.moderations.create({
          model: "omni-moderation-latest",
          input: pun,
        });
        if (moderation.results[0].flagged) {
          console.warn(`Pun flagged: ${JSON.stringify(moderation)}`);
          await this.env.DB.prepare(`UPDATE puns SET status=? WHERE id=?`)
            .bind("flagged", punId)
            .run();
          throw new NonRetryableError(`Pun ${punId} failed moderation`);
        }
        return true;
      });
    } else {
      console.warn(
        "OPENAI_API_KEY is not present in your environment, set it to enable moderation",
      );
    }

    // step: Wait For a human moderator to approve or reject
    let approved = false;
    try {
      const decision = await step.waitForEvent<{ approved: boolean }>(
        "wait-for-moderator",
        {
          type: "moderator-decision",
          timeout: "1 hour",
        },
      );
      approved = decision.payload.approved;
    } catch (e) {
      // no decision arrived before the timeout
      console.warn(`No moderator decision for pun ${punId}`);
    }
    if (!approved) {
      await step.do("mark-rejected", async () => {
        await this.env.DB.prepare(`UPDATE puns SET status=? WHERE id=?`)
          .bind("flagged", punId)
          .run();
      });
      return;
    }

    // step: Categorize
    const categories = await step.do(
      "categorize-pun",
      {
        retries: {
          limit: 4,
          delay: "5 seconds",
          backoff: "exponential",
        },
        timeout: "1 minute",
      },
      async () => {
        if (this.env.LLM_FAKE === "true") {
          return "Test, Offline";
        }
        const results = await talkToLLM(this.env.LM_STUDIO_URL, pun);
        return results;
      },
    );

    // Step: Update the db
    await step.do("save-categories-and-publish", async () => {
      const results = await this.env.DB.prepare(
        `UPDATE puns SET status=?, categories=? WHERE id=?`,
      )
        .bind("published", categories, punId)
        .run();
    });
  }
}
