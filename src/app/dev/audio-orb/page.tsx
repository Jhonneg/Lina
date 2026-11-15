import { notFound } from "next/navigation";
import { AudioOrbPreview } from "../../../components/orb/audio-orb-preview";

export default function AudioOrbPreviewPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <AudioOrbPreview />;
}
