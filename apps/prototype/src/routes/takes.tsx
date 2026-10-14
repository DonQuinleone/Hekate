import { Soon } from "./_soon.tsx";

export function SessionPage({ sessionId }: { sessionId: string }) {
  return <Soon title={`Session ${sessionId}`} round={2} />;
}

export function TakePage({ takeId }: { takeId: string }) {
  return <Soon title={`Take ${takeId}`} round={2} />;
}
