import { useLocalRuntime, type ChatModelAdapter } from "@assistant-ui/react";

export default function useChatRuntime() {
  const MyModelAdapter: ChatModelAdapter = {
    async run({ messages, abortSignal }) {
      return {
        content: [
          {
            type: "text",
            text: "Demo",
          },
        ],
      };
    },
  };

  return useLocalRuntime(MyModelAdapter);
}
