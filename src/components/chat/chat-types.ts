export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  status?: "streaming" | "complete" | "interrupted";
};
