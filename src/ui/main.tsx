import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { LarkMessageShareDialog } from "./components/chat/LarkMessageShareDialog";
import { SettingsPage } from "./components/SettingsPage";
import type { ShareMessage } from "../shared/types";
import "./index.css";

function ShareWindow() {
  // Paint the real card while hidden, before arming clipboard detection.
  const [share, setShare] = useState<ShareMessage | null>({ id: "preload", text: "" });
  useEffect(() => {
    const unsubscribe = window.electron.onShare((nextShare) => {
      if (nextShare) console.info("[share-ui] received", { shareId: nextShare.id, characters: Array.from(nextShare.text).length });
      setShare(nextShare);
    });
    return unsubscribe;
  }, []);

  const closeShare = () => {
    window.electron.closeShare();
    setShare(null);
  };

  return <main className="h-full bg-white">
    {share && <LarkMessageShareDialog
      key={share.id}
      shareId={share.id}
      message={share.text}
      onClose={closeShare}
    />}
  </main>;
}

const isSettings = new URLSearchParams(window.location.search).get("view") === "settings";
createRoot(document.getElementById("root")!).render(isSettings ? <SettingsPage /> : <ShareWindow />);
