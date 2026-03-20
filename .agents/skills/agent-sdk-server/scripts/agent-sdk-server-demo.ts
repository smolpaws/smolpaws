type StartConversationResponse = {
  id: string;
  created_at: string;
  updated_at: string;
  execution_status: string;
};

const baseUrl = process.env.SMOLPAWS_RUNNER_URL ?? "http://localhost:3000";
const token = process.env.SMOLPAWS_RUNNER_TOKEN;

const headers: Record<string, string> = {
  "content-type": "application/json",
};
if (token) {
  headers.authorization = `Bearer ${token}`;
}

async function main(): Promise<void> {
  const startRes = await fetch(`${baseUrl}/api/conversations`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      agent: {
        llm: {
          model: process.env.LLM_MODEL ?? "claude-sonnet-4-20250514",
          provider: process.env.LLM_PROVIDER ?? "anthropic",
          api_key: process.env.LLM_API_KEY ?? "",
        },
      },
      initial_message: {
        role: "user",
        content: [{ type: "text", text: "Say hello from the agent server." }],
        run: true,
      },
    }),
  });

  const conversation = (await startRes.json()) as StartConversationResponse;
  console.log("Conversation:", conversation);

  const eventsRes = await fetch(
    `${baseUrl}/api/conversations/${conversation.id}/events/search`,
    { headers },
  );
  console.log("Events:", await eventsRes.json());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
