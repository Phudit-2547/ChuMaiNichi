import useAuthStore from "@/features/auth/stores/auth-store";
import { useLocalRuntime, type ChatModelAdapter } from "@assistant-ui/react";
import axios from "axios";

export default function useChatRuntime() {
  const { getAuthHeaders } = useAuthStore();
  const MyModelAdapter: ChatModelAdapter = {
    async run({ messages, abortSignal }) {
      // TODO replace with your own API
      const response = await axios.post("/api/chat", {
        headers: {
          ...getAuthHeaders,
          "Content-Type": "application/json",
        },
        // forward the messages in the chat to the API
        body: JSON.stringify({
          messages: messages.map((m) => ({
            role: m.role,
            content:
              typeof m.content === "string"
                ? m.content
                : m.content
                    .filter((p) => p.type === "text")
                    .map((p) => p.text)
                    .join(""),
          })),
        }),
        // if the user hits the "cancel" button or escape keyboard key, cancel the request
        signal: abortSignal,
      });

      const data = await response.data;
      return {
        content: [
          {
            type: "text",
            text: data.text,
          },
        ],
      };
    },
  };

  return useLocalRuntime(MyModelAdapter);
}
