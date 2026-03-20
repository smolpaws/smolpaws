import { LLMFactory } from "@smolpaws/agent-sdk";

async function main(): Promise<void> {
  const model = process.env.LLM_MODEL ?? "claude-sonnet-4-20250514";
  const apiKey = process.env.LLM_API_KEY ?? "";

  const client = await new LLMFactory({
    provider: "anthropic",
    model,
    apiKey,
    temperature: 0.7,
  }).createClient();

  const response = await client.chat({
    systemPrompt: "You are a helpful assistant.",
    messages: [{ role: "user", content: [{ type: "text", text: "Hello!" }] }],
    tools: [],
  });

  console.log(response.message.content);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
