import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { CheckCircle2, CircleAlert, ExternalLink, LoaderCircle } from "lucide-react";
import type { AppState } from "../../shared/types";

const buttonClass = "inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";
const inputClass = "h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-[#3156e8] focus:ring-1 focus:ring-[#3156e8]";
const authLabels: Record<string, string> = {
  unconfigured: "请先保存应用配置",
  "logged-out": "未登录",
  pending: "等待本人授权",
  authenticated: "已以本人身份登录",
  error: "授权异常",
};
const loginLabels: Record<string, string> = {
  enabled: "已开启，登录电脑后静默运行",
  "not-registered": "已关闭",
  "requires-approval": "等待 macOS 允许登录自启",
  "not-found": "登录项注册失败，请重新开启",
};

function errorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "").trim();
}

export function SettingsPage() {
  const [state, setState] = useState<AppState | null>(null);
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [codexHome, setCodexHome] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [qrImage, setQrImage] = useState("");
  const [qrError, setQrError] = useState(false);

  useEffect(() => {
    const unsubscribe = window.electron.onState(setState);
    void window.electron.getSettings().then((initial) => {
      setState(initial);
      setAppId(initial.appId);
      setCodexHome(initial.hook.codexHome);
    }).catch((failure) => setError(errorMessage(failure)));
    return unsubscribe;
  }, []);

  const authUrl = state?.auth.url;
  useEffect(() => {
    let cancelled = false;
    setQrImage("");
    setQrError(false);
    if (authUrl) void QRCode.toDataURL(authUrl, { width: 180, margin: 2 }).then((image) => {
      if (!cancelled) setQrImage(image);
    }).catch(() => {
      if (!cancelled) setQrError(true);
    });
    return () => { cancelled = true; };
  }, [authUrl]);

  const perform = async (action: string, task: () => Promise<AppState>, success: string) => {
    if (busy) return;
    setBusy(action);
    setError("");
    setNotice("");
    try {
      const nextState = await task();
      setState(nextState);
      setNotice(success);
      console.info("[settings-ui] action completed", { action });
    } catch (failure) {
      setError(errorMessage(failure));
      console.info("[settings-ui] action failed", { action });
    } finally {
      setBusy("");
    }
  };

  return <main className="settings-page text-slate-900">
    <header className="settings-header">
      <h1 className="text-xl font-semibold">codex分享飞书消息 <span className="ml-2 text-sm font-normal text-slate-500">{state ? `v${state.version}` : ""}</span></h1>
      <p className="mt-1 text-sm text-slate-500">完成一次配置，之后复制 Codex 整条最终回复即可分享。</p>
    </header>

    {error && <div role="alert" className="settings-feedback flex gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"><CircleAlert className="h-5 w-5 shrink-0" /><span className="whitespace-pre-wrap break-words">{error}</span></div>}
    {notice && <div role="status" className="settings-feedback flex gap-2 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800"><CheckCircle2 className="h-5 w-5 shrink-0" />{notice}</div>}

    <div className="settings-modules">
    <section className="settings-card border border-slate-200 bg-white" aria-labelledby="app-config-title">
      <h2 id="app-config-title" className="text-base font-semibold">飞书应用配置</h2>
      <p className="mt-1 text-xs leading-5 text-slate-500">使用本软件独立配置；App Secret 存入私有 CLI 的加密存储。</p>
      <form className="mt-4 space-y-3" onSubmit={(event) => {
        event.preventDefault();
        void perform("save", async () => {
          const saved = await window.electron.saveConfig({ appId: appId.trim(), appSecret });
          setAppSecret("");
          return saved;
        }, "配置已保存。首次配置或更换应用后，请登录飞书。");
      }}>
        <label className="block text-sm font-medium">App ID<input className={`${inputClass} mt-1.5`} value={appId} onChange={(event) => setAppId(event.target.value)} placeholder="cli_…" autoComplete="off" spellCheck={false} required /></label>
        <label className="block text-sm font-medium">App Secret<input className={`${inputClass} mt-1.5`} type="password" value={appSecret} onChange={(event) => setAppSecret(event.target.value)} placeholder={state?.configured ? "输入密钥以更新配置" : "飞书应用密钥"} autoComplete="new-password" required /></label>
        <button className={buttonClass} disabled={Boolean(busy) || !appId.trim() || !appSecret.trim()} type="submit">{busy === "save" && <LoaderCircle className="h-4 w-4 animate-spin" />}保存配置</button>
      </form>
      <fieldset className="mt-6 space-y-3 border-t border-slate-200 pt-4">
        <legend className="text-sm font-semibold">程序运行设置</legend>
        <label className="flex items-start gap-2.5 text-sm" htmlFor="hide-dock">
          <input id="hide-dock" type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-[#3156e8]" checked={Boolean(state?.desktop.hideDock)} disabled={!state || Boolean(busy)} aria-describedby="hide-dock-description" onChange={(event) => void perform("set-hide-dock", () => window.electron.setHideDock(event.target.checked), "程序坞显示设置已保存。")} />
          <span><span className="font-medium">隐藏程序坞图标</span><span id="hide-dock-description" className="mt-1 block text-xs leading-5 text-slate-500">只保留状态栏图标，关闭窗口后继续后台运行。</span></span>
        </label>
        <label className="flex items-start gap-2.5 text-sm" htmlFor="open-at-login">
          <input id="open-at-login" type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-[#3156e8]" checked={Boolean(state?.desktop.openAtLogin)} disabled={!state?.desktop.loginAvailable || Boolean(busy)} aria-describedby="open-at-login-description login-item-status" onChange={(event) => void perform("set-open-at-login", () => window.electron.setOpenAtLogin(event.target.checked), "登录自启设置已更新。")} />
          <span><span className="font-medium">登录电脑自动启动</span><span id="open-at-login-description" className="mt-1 block text-xs leading-5 text-slate-500">登录后静默运行，需 macOS 允许此登录项。</span></span>
        </label>
        <p id="login-item-status" className="text-xs leading-5 text-slate-500" aria-live="polite">{!state ? "正在读取设置…" : !state.desktop.loginAvailable ? "安装正式 App 后可设置登录自启。" : loginLabels[state.desktop.loginStatus] || `登录项状态：${state.desktop.loginStatus}`}</p>
        {state?.desktop.loginStatus === "requires-approval" && <button className={buttonClass} type="button" onClick={() => {
          console.info("[settings-ui] action requested", { action: "open-login-settings" });
          window.electron.openLoginSettings();
        }}>打开 macOS 登录项设置</button>}
      </fieldset>
    </section>

    <section className="settings-card border border-slate-200 bg-white" aria-labelledby="auth-title">
      <h2 id="auth-title" className="text-base font-semibold">本人登录授权</h2>
      <p className="mt-2 text-sm" aria-live="polite">{state ? authLabels[state.auth.status] || state.auth.status : "正在读取状态…"}{state?.auth.userName && <span className="ml-2 font-medium">{state.auth.userName}</span>}</p>
      <p className="mt-1 text-xs leading-5 text-slate-500">App ID 和 Secret 是应用凭据；完成本人授权后，消息才会以你的身份发送。</p>
      <div className="mt-3 flex gap-2">
        <button className={buttonClass} type="button" disabled={Boolean(busy) || !state?.configured || state.auth.status === "pending"} onClick={() => void perform("login", () => window.electron.login(), "请扫码或打开下方链接，完成本人授权。")}>{busy === "login" && <LoaderCircle className="h-4 w-4 animate-spin" />}登录飞书</button>
        <button className={buttonClass} type="button" disabled={Boolean(busy) || !state?.configured || state.auth.status === "logged-out"} onClick={() => void perform("logout", () => window.electron.logout(), "已退出本软件的本地登录。")}>退出登录</button>
      </div>
      {authUrl && <div className="settings-auth-code mt-4 rounded-lg bg-slate-50 p-3">
        {qrImage ? <img src={qrImage} alt="飞书本人授权二维码" className="h-[180px] w-[180px] shrink-0 rounded bg-white" /> : <div className="grid h-[180px] w-[180px] shrink-0 place-items-center text-xs text-slate-500">{qrError ? "二维码生成失败，请使用链接" : "生成二维码…"}</div>}
        <div className="min-w-0 text-sm">
          <p className="font-medium">扫码授权，或打开链接</p>
          <a href={authUrl} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs leading-5 text-[#3156e8] underline">打开授权链接<ExternalLink className="h-3 w-3" /></a>
          <p className="mt-1 text-xs leading-5 text-slate-500">授权结果会自动更新，无需粘贴 token。</p>
        </div>
      </div>}
      {state?.auth.error && <p role="alert" className="mt-3 whitespace-pre-wrap break-words text-xs leading-5 text-red-700">{state.auth.error}</p>}
      {Boolean(state?.auth.missingScopes?.length) && <p className="mt-3 break-words text-xs leading-5 text-red-700">缺少权限：{state?.auth.missingScopes?.join("、")}</p>}
      <p className="mt-4 text-xs leading-5 text-slate-500">应用需开通并发布：contact:user:search、im:chat:read、im:message.send_as_user、im:message。</p>
      <a href="https://open.feishu.cn/app" target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs text-[#3156e8] hover:underline">打开飞书开放平台<ExternalLink className="h-3 w-3" /></a>
    </section>

    <section className="settings-card border border-slate-200 bg-white" aria-labelledby="hook-title">
      <h2 id="hook-title" className="text-base font-semibold">Codex Hook 接入与监听</h2>
      <p className="mt-2 text-sm" aria-live="polite">{state?.hook.capturedAt ? "已收到最终回复，捕获正常" : state?.hook.installed ? "Hook 已安装，等待最终回复验证" : "Hook 尚未安装"}</p>
      {state?.hook.capturedAt && <p className="mt-1 text-xs text-slate-500">最近捕获：{new Date(state.hook.capturedAt).toLocaleString("zh-CN")}</p>}
      <label className="mt-3 block text-sm font-medium">Codex 配置目录<input className={`${inputClass} mt-1.5`} value={codexHome} onChange={(event) => setCodexHome(event.target.value)} placeholder="默认 ~/.codex；自定义时填写绝对路径" spellCheck={false} /></label>
      <button type="button" className={`${buttonClass} mt-3`} disabled={Boolean(busy) || !state} onClick={() => void perform("hook", () => window.electron.installHook({ codexHome: codexHome.trim() }), "Hook 已安装。请在 Codex 审阅并信任，再重启或重新加载会话。")}>{busy === "hook" && <LoaderCircle className="h-4 w-4 animate-spin" />}安装 / 更新 Hook</button>
      <p className="mt-3 text-xs leading-5 text-slate-500">保留其他 Hook 并备份原配置；安装后要在 Codex 信任并重载会话。首次收到真实最终回复后才显示捕获正常。</p>
      <p className="mt-3 text-xs text-slate-600">剪贴板监听：{state?.listener.status === "listening" ? "正常监听" : state?.listener.status === "error" ? "监听异常" : "正在启动"}</p>
      {state?.listener.error && <p role="alert" className="mt-1 break-words text-xs leading-5 text-red-700">{state.listener.error}</p>}
    </section>
    </div>
  </main>;
}
