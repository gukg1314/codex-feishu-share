import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CircleX, Search, UserRound, UsersRound } from "lucide-react";

import { withSearchTimeout } from "../../utils/lark-search";
import type { LarkContactOption, LarkShareRecipient } from "../../../shared/types";

type LarkShareTab = "people" | "chats";

export type LarkMessageShareDialogProps = {
  shareId: string;
  message: string;
  onClose: () => void;
};

const SEARCH_DEBOUNCE_MS = 180;
const SEARCH_TIMEOUT_MS = 6_000;

function formatLarkShareError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .trim() || "飞书操作失败，请检查 lark-cli 配置后重试。";
}

function RecipientAvatar({ recipient }: { recipient: LarkShareRecipient }) {
  return <span className="share-avatar" aria-hidden="true">
    {Array.from(recipient.name.trim()).at(-1) || "?"}
    {recipient.avatarUrl && <img src={recipient.avatarUrl} alt="" referrerPolicy="no-referrer"
      onError={(event) => { event.currentTarget.hidden = true; }} />}
  </span>;
}

export function LarkMessageShareDialog({ shareId, message, onClose }: LarkMessageShareDialogProps) {
  const [query, setQuery] = useState("");
  const [activeTab, setActiveTab] = useState<LarkShareTab>("people");
  const [people, setPeople] = useState<LarkShareRecipient[]>([]);
  const [chats, setChats] = useState<LarkShareRecipient[]>([]);
  const [selected, setSelected] = useState<LarkShareRecipient | null>(null);
  const [peopleLoading, setPeopleLoading] = useState(false);
  const [chatsLoading, setChatsLoading] = useState(false);
  const [peopleError, setPeopleError] = useState<string | null>(null);
  const [chatsError, setChatsError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const requestIdRef = useRef(0);
  const cardRef = useRef<HTMLDivElement>(null);
  const sendingRef = useRef(false);
  const requestedHeightRef = useRef(0);

  const recipients = activeTab === "people" ? people : chats;
  const loading = activeTab === "people" ? peopleLoading : chatsLoading;
  const recipientLabel = activeTab === "people" ? "人员" : "群聊";
  const activeSearchError = activeTab === "people" ? peopleError : chatsError;
  const searchError = !loading && recipients.length === 0
    ? activeSearchError
    : null;

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const resize = () => {
      const maxHeight = card.style.maxHeight;
      // Measure before the current viewport cap, then let the main process fit the screen.
      card.style.maxHeight = "none";
      const height = Math.ceil(Math.min(760, Math.max(card.scrollHeight, card.getBoundingClientRect().height)));
      card.style.maxHeight = maxHeight;
      if (height === requestedHeightRef.current) return;
      requestedHeightRef.current = height;
      console.info("[share-ui] size requested", { shareId, height });
      window.electron.resizeShare({ height });
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(card);
    return () => observer.disconnect();
  }, [shareId, recipients, loading, searchError, activeTab, query]);

  useEffect(() => {
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => window.electron.reportRendered({ shareId }));
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
      requestIdRef.current += 1;
    };
  }, [shareId]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || sendingRef.current) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, sending]);

  useEffect(() => {
    const normalized = query.trim();
    const requestId = ++requestIdRef.current;
    setPeople([]);
    setChats([]);
    setPeopleError(null);
    setChatsError(null);

    if (!normalized) {
      setPeopleLoading(false);
      setChatsLoading(false);
      return;
    }

    setPeopleLoading(true);
    setChatsLoading(true);
    const timer = window.setTimeout(() => {
      void withSearchTimeout(window.electron.searchLarkContacts(normalized), "人员", SEARCH_TIMEOUT_MS)
        .then((contacts: LarkContactOption[]) => {
          if (requestIdRef.current !== requestId) return;
          console.info("[share-ui] search complete", { shareId, kind: "user", count: contacts.length });
          setPeople(contacts.map((contact) => ({
            kind: "user",
            id: contact.openId,
            name: contact.name,
            detail: contact.department || "人员",
            avatarUrl: contact.avatarUrl,
          })));
        })
        .catch((error) => {
          if (requestIdRef.current !== requestId) return;
          console.info("[share-ui] search failed", { shareId, kind: "user" });
          setPeopleError(formatLarkShareError(error));
        })
        .finally(() => {
          if (requestIdRef.current === requestId) setPeopleLoading(false);
        });

      void withSearchTimeout(window.electron.searchLarkShareChats(normalized), "群聊", SEARCH_TIMEOUT_MS)
        .then((result) => {
          if (requestIdRef.current !== requestId) return;
          console.info("[share-ui] search complete", { shareId, kind: "chat", count: result.length });
          setChats(result);
        })
        .catch((error) => {
          if (requestIdRef.current !== requestId) return;
          console.info("[share-ui] search failed", { shareId, kind: "chat" });
          setChatsError(formatLarkShareError(error));
        })
        .finally(() => {
          if (requestIdRef.current === requestId) setChatsLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [query]);

  const handleQueryChange = (value: string) => {
    setQuery(value);
    setSelected(null);
  };

  const handleTabChange = (tab: LarkShareTab) => {
    if (tab === activeTab) return;
    setActiveTab(tab);
    setSelected(null);
    console.info("[share-ui] tab changed", { shareId, tab });
  };

  const handleSelect = (recipient: LarkShareRecipient) => {
    setSelected(recipient);
    console.info("[share-ui] recipient selected", { shareId, kind: recipient.kind });
  };

  const handleSend = async () => {
    if (!selected || sendingRef.current) return;
    const recipient = selected;
    sendingRef.current = true;
    setSending(true);
    console.info("[share-ui] send requested", { shareId, kind: recipient.kind });
    try {
      await window.electron.sendLarkShareMessage({ recipient, text: message });
    } catch {
      console.info("[share-ui] send failed; see local log", { shareId });
      sendingRef.current = false;
      setSending(false);
    }
  };

  return (
    <div ref={cardRef} role="dialog" aria-modal="true" aria-label="发送到飞书" className="share-dialog">
      <div role="tablist" aria-label="选择接收对象类型" className="share-tabs">
        <button id="lark-share-people-tab" type="button" role="tab"
          aria-selected={activeTab === "people"} aria-controls="lark-share-recipient-results"
          onClick={() => handleTabChange("people")} className="share-tab">
          <UserRound aria-hidden="true" />人员
        </button>
        <button id="lark-share-chats-tab" type="button" role="tab"
          aria-selected={activeTab === "chats"} aria-controls="lark-share-recipient-results"
          onClick={() => handleTabChange("chats")} className="share-tab">
          <UsersRound aria-hidden="true" />群聊
        </button>
      </div>

      <div className="share-search">
        <Search aria-hidden="true" />
        <input id="lark-share-recipient-search" autoFocus aria-label={"搜索" + recipientLabel}
          value={query} onChange={(event) => handleQueryChange(event.target.value)}
          placeholder={"搜索" + recipientLabel} className="share-search-input" />
        {query && <button type="button" aria-label="清空搜索" onClick={() => handleQueryChange("")}
          className="share-clear"><CircleX aria-hidden="true" /></button>}
      </div>

      <div id="lark-share-recipient-results" role="tabpanel"
        aria-labelledby={activeTab === "people" ? "lark-share-people-tab" : "lark-share-chats-tab"}
        className="share-results share-glass">
        {!query.trim() ? (
          <div className="share-empty">输入名称搜索</div>
        ) : recipients.length === 0 && loading ? (
          <div className="share-empty" aria-live="polite">搜索中…</div>
        ) : searchError ? (
          <div className="share-empty is-error" role="alert">{searchError}</div>
        ) : recipients.length === 0 ? (
          <div className="share-empty">无匹配结果</div>
        ) : (
          <>
            {recipients.map((recipient) => {
              const isSelected = selected?.kind === recipient.kind && selected.id === recipient.id;
              return <label key={recipient.kind + ":" + recipient.id}
                className={"share-recipient-row" + (isSelected ? " is-selected" : "")}>
                <input type="radio" name="lark-share-recipient" checked={isSelected}
                  onChange={() => handleSelect(recipient)} aria-label={"选择" + recipient.name} />
                <RecipientAvatar recipient={recipient} />
                <span className="share-recipient-text">
                  <span className="share-recipient-name">{recipient.name}</span>
                  <span className="share-recipient-detail">{recipient.detail || (recipient.kind === "user" ? "人员" : "群聊")}</span>
                </span>
              </label>;
            })}
            {loading && <div className="share-loading-more" aria-live="polite">搜索中…</div>}
          </>
        )}
      </div>

      <footer className="share-footer">
        <p className="share-count">已选 {selected ? 1 : 0} {activeTab === "people" ? "人" : "个群聊"}</p>
        <div className="share-actions">
          <button type="button" disabled={sending} onClick={onClose} className="share-action">取消</button>
          <button type="button" disabled={!selected || sending} onClick={() => void handleSend()}
            className="share-action share-action-primary">确认</button>
        </div>
      </footer>
    </div>
  );
}
