import { AppAccessGate } from "@/components/AppAccessGate";
import { MultilingualTextMap } from "@/components/MultilingualTextMap";

export default function Home() {
  return (
    <AppAccessGate>
      <MultilingualTextMap />
    </AppAccessGate>
  );
}
