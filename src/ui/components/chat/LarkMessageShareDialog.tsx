import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CircleX, UserRound, UsersRound } from "lucide-react";

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
  const RecipientIcon = recipient.kind === "user" ? UserRound : UsersRound;
  return (
    <span
      className={`relative grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-full border ${
        recipient.kind === "user"
          ? "border-slate-200 bg-slate-100 text-slate-500"
          : "border-indigo-200 bg-indigo-50 text-indigo-600"
      }`}
    >
      <RecipientIcon className="h-[18px] w-[18px]" aria-hidden="true" />
      {recipient.avatarUrl && (
        <img
          src={recipient.avatarUrl}
          alt=""
          referrerPolicy="no-referrer"
          className="absolute inset-0 h-full w-full object-cover"
          onError={(event) => {
            event.currentTarget.hidden = true;
          }}
        />
      )}
    </span>
  );
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
          setPeople(contacts.map((contact) => ({
            kind: "user",
            id: contact.openId,
            name: contact.name,
            detail: contact.department || "人员",
          })));
        })
        .catch((error) => {
          if (requestIdRef.current !== requestId) return;
          setPeopleError(formatLarkShareError(error));
        })
        .finally(() => {
          if (requestIdRef.current === requestId) setPeopleLoading(false);
        });

      void withSearchTimeout(window.electron.searchLarkShareChats(normalized), "群聊", SEARCH_TIMEOUT_MS)
        .then((result) => {
          if (requestIdRef.current !== requestId) return;
          setChats(result);
        })
        .catch((error) => {
          if (requestIdRef.current !== requestId) return;
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
  };

  const handleSend = async () => {
    if (!selected || sendingRef.current) return;
    const recipient = selected;
    sendingRef.current = true;
    setSending(true);
    try {
      await window.electron.sendLarkShareMessage({ recipient, text: message });
    } catch {
      console.info("[share-ui] send failed; see local log", { shareId });
      sendingRef.current = false;
      setSending(false);
    }
  };

  return (
    <div
      ref={cardRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="lark-share-dialog-title"
      className="flex max-h-[min(760px,100vh)] w-full flex-col overflow-hidden bg-white"
    >
        <header className="shrink-0 border-b border-slate-200 px-5 py-4">
          <div>
            <h2 id="lark-share-dialog-title" className="text-[17px] font-semibold text-slate-950">发送到飞书</h2>
            <p className="mt-1 text-xs text-slate-500">选择一个人员或群聊，发送当前回复</p>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-4">
          <div
            role="tablist"
            aria-label="选择接收对象类型"
            className="mb-3 grid h-10 shrink-0 grid-cols-2 gap-1 rounded-[9px] bg-slate-100 p-1"
          >
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "people"}
              aria-controls="lark-share-recipient-results"
              onClick={() => handleTabChange("people")}
              className={`inline-flex items-center justify-center gap-2 rounded-[7px] text-sm font-medium transition ${
                activeTab === "people"
                  ? "bg-white text-[#3156e8] shadow-sm ring-1 ring-slate-200"
                  : "text-slate-600 hover:bg-white/60 hover:text-slate-900"
              }`}
            >
              <UserRound className="h-4 w-4" aria-hidden="true" />
              人员
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "chats"}
              aria-controls="lark-share-recipient-results"
              onClick={() => handleTabChange("chats")}
              className={`inline-flex items-center justify-center gap-2 rounded-[7px] text-sm font-medium transition ${
                activeTab === "chats"
                  ? "bg-white text-[#3156e8] shadow-sm ring-1 ring-slate-200"
                  : "text-slate-600 hover:bg-white/60 hover:text-slate-900"
              }`}
            >
              <UsersRound className="h-4 w-4" aria-hidden="true" />
              群聊
            </button>
          </div>

          <div className="relative shrink-0">
            <input
              id="lark-share-recipient-search"
              autoFocus
              value={query}
              onChange={(event) => handleQueryChange(event.target.value)}
              placeholder={`输入${recipientLabel}名称`}
              className="h-10 w-full rounded-[8px] border border-slate-300 bg-white px-3 pr-10 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-[#3156e8] focus:ring-1 focus:ring-[#3156e8]"
            />
            {query && (
              <button
                type="button"
                aria-label="清空搜索"
                onClick={() => handleQueryChange("")}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 transition hover:text-slate-600"
              >
                <CircleX className="h-[18px] w-[18px]" aria-hidden="true" />
              </button>
            )}
          </div>

          <div
            id="lark-share-recipient-results"
            role="tabpanel"
            className="mt-3 min-h-[240px] max-h-[410px] flex-1 overflow-y-auto rounded-[10px] border border-slate-200 bg-white p-2"
          >
            {!query.trim() ? (
              <div className="grid h-full min-h-[220px] place-items-center text-sm text-slate-400">输入{recipientLabel}名称开始搜索</div>
            ) : recipients.length === 0 && loading ? (
              <div className="grid h-full min-h-[220px] place-items-center text-sm text-slate-500" aria-live="polite">正在搜索{recipientLabel}…</div>
            ) : searchError ? (
              <div className="grid h-full min-h-[220px] place-items-center px-8 text-center text-sm leading-6 text-red-600" role="alert">{searchError}</div>
            ) : recipients.length === 0 ? (
              <div className="grid h-full min-h-[220px] place-items-center text-sm text-slate-400">没有找到匹配的{recipientLabel}</div>
            ) : (
              <div className="space-y-0.5">
                {recipients.map((recipient) => {
                  const isSelected = selected?.kind === recipient.kind && selected.id === recipient.id;
                  return (
                    <label
                      key={`${recipient.kind}:${recipient.id}`}
                      className={`flex cursor-pointer items-center gap-3 rounded-[8px] px-2.5 py-2 transition ${
                        isSelected ? "bg-[#f1f5ff]" : "hover:bg-slate-50"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => setSelected(isSelected ? null : recipient)}
                        className="h-[18px] w-[18px] shrink-0 cursor-pointer rounded border-slate-300 accent-[#3156e8]"
                        aria-label={`选择${recipient.name}`}
                      />
                      <RecipientAvatar recipient={recipient} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[15px] font-medium leading-5 text-slate-900">{recipient.name}</span>
                        <span className="mt-0.5 block truncate text-xs leading-4 text-slate-500">{recipient.detail || (recipient.kind === "user" ? "人员" : "群聊")}</span>
                      </span>
                    </label>
                  );
                })}
                {loading && (
                  <div className="px-3 py-2 text-center text-xs text-slate-400" aria-live="polite">正在补充更多结果…</div>
                )}
              </div>
            )}
          </div>

        </div>

        <footer className="flex shrink-0 items-center justify-between gap-4 border-t border-slate-200 bg-white px-5 py-3.5">
          <div className="min-w-0">
            <p className="text-sm text-slate-700">已选择：<span className="font-semibold text-slate-950">{selected ? 1 : 0}</span> 个</p>
            <p className="mt-0.5 truncate text-[11px] text-slate-400">将以当前登录的飞书账号本人身份发送</p>
          </div>
          <div className="flex shrink-0 items-center gap-2.5">
            <button
              type="button"
              disabled={sending}
              onClick={onClose}
              className="h-10 rounded-[8px] border border-slate-300 bg-white px-5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              取消
            </button>
            <button
              type="button"
              disabled={!selected || sending}
              onClick={() => void handleSend()}
              className="inline-flex h-10 min-w-[92px] items-center justify-center gap-2 rounded-[8px] bg-[#3156e8] px-5 text-sm font-medium text-white transition hover:bg-[#2748cf] disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              确认
            </button>
          </div>
        </footer>
    </div>
  );
}
