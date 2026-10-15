import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { AppWindow, Check, CheckCircle2, CircleAlert, ExternalLink, LoaderCircle, Monitor, Plug, Power, Sparkles, UserRound } from "lucide-react";
import appIcon from "../../../assets/dock-icon.png";
import type { AppState } from "../../shared/types";

const buttonClass = "settings-button";
const inputClass = "settings-input";
const authLabels: Record<string, string> = {
  unconfigured: "先保存应用",
  "logged-out": "未登录",
  pending: "等待授权",
  authenticated: "已登录",
  error: "授权异常",
};
const loginLabels: Record<string, string> = {
  enabled: "",
  "not-registered": "",
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
      console.info("[settings-ui] state loaded", {
        configured: initial.configured,
        auth: initial.auth.status,
        hookInstalled: initial.hook.installed,
        listener: initial.listener.status,
      });
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

  const ready = Boolean(state?.configured && state.auth.status === "authenticated"
    && state.hook.installed && state.hook.capturedAt && state.listener.status === "listening");
  const authStatus = state ? authLabels[state.auth.status] || state.auth.status : "读取中";
  const hookStatus = state?.hook.capturedAt ? "正常" : state?.hook.installed ? "待验证" : "未安装";
  const hookDetail = state?.hook.capturedAt ? "已收到完整回复" : state?.hook.installed ? "等待最终回复" : "Hook 尚未安装";
  const loginStatus = !state ? "正在读取设置…" : !state.desktop.loginAvailable
    ? "安装正式 App 后可开启" : loginLabels[state.desktop.loginStatus] || "";

  return <main className="settings-page">
    <header className="settings-header settings-glass">
      <div className="settings-brand">
        <img src={appIcon} alt="" className="settings-app-icon" />
        <h1>分享设置</h1>
        {state && <span className="settings-version">v{state.version}</span>}
      </div>
      <div className={"settings-overall" + (ready ? " is-ready" : "")} role="status">
        <span className="settings-overall-icon">{ready ? <Check aria-hidden="true" /> : <CircleAlert aria-hidden="true" />}</span>
        {state ? ready ? "分享已就绪" : "待完成配置" : "读取中"}
      </div>
    </header>

    {error && <div role="alert" className="settings-feedback settings-feedback-error"><CircleAlert aria-hidden="true" /><span>{error}</span></div>}
    {notice && <div role="status" className="settings-feedback settings-feedback-success"><CheckCircle2 aria-hidden="true" /><span>{notice}</span></div>}

    <div className="settings-modules">
      <section className="settings-card settings-glass settings-app-card" aria-labelledby="app-config-title">
        <div className="settings-card-header">
          <span className="settings-card-icon"><AppWindow aria-hidden="true" /></span>
          <h2 id="app-config-title">飞书应用</h2>
          <span className={"settings-badge" + (state?.configured ? " is-good" : "")}>{state?.configured ? "已配置" : "待配置"}</span>
        </div>
        <form className="settings-form" onSubmit={(event) => {
          event.preventDefault();
          void perform("save", async () => {
            const saved = await window.electron.saveConfig({ appId: appId.trim(), appSecret });
            setAppSecret("");
            return saved;
          }, "配置已保存。首次配置或更换应用后，请登录飞书。");
        }}>
          <label>App ID<input className={inputClass} value={appId} onChange={(event) => setAppId(event.target.value)} placeholder="cli_…" autoComplete="off" spellCheck={false} required /></label>
          <label>App Secret<input className={inputClass} type="password" value={appSecret} onChange={(event) => setAppSecret(event.target.value)} placeholder={state?.configured ? "输入新密钥" : "飞书应用密钥"} autoComplete="new-password" required /></label>
          <button className={buttonClass + " settings-button-primary"} disabled={Boolean(busy) || !appId.trim() || !appSecret.trim()} type="submit">{busy === "save" && <LoaderCircle className="settings-spinner" aria-hidden="true" />}保存配置</button>
        </form>
      </section>

      <section className="settings-card settings-glass settings-auth-card" aria-labelledby="auth-title">
        <div className="settings-card-header">
          <span className="settings-card-icon"><UserRound aria-hidden="true" /></span>
          <h2 id="auth-title">本人登录</h2>
          <span className={"settings-badge" + (state?.auth.status === "authenticated" ? " is-good" : "")}>{authStatus}</span>
        </div>
        <p className="settings-inline-status settings-auth-status" aria-live="polite">
          <span className="settings-status-icon">{state?.auth.status === "authenticated" ? <Check aria-hidden="true" /> : <CircleAlert aria-hidden="true" />}</span>
          <span title={state?.auth.userName}>{state?.auth.userName ? state.auth.userName + " · 本人发送" : state?.auth.status === "authenticated" ? "以本人身份发送" : authStatus}</span>
        </p>
        <div className="settings-auth-actions">
          <button className={buttonClass + " settings-button-primary"} type="button" disabled={Boolean(busy) || !state?.configured || state.auth.status === "pending"} onClick={() => void perform("login", () => window.electron.login(), "请扫码或打开下方链接，完成本人授权。")}>{busy === "login" && <LoaderCircle className="settings-spinner" aria-hidden="true" />}登录飞书</button>
          <button className={buttonClass} type="button" disabled={Boolean(busy) || !state?.configured || state.auth.status === "logged-out"} onClick={() => void perform("logout", () => window.electron.logout(), "已退出本软件的本地登录。")}>退出登录</button>
        </div>
        {authUrl && <div className="settings-auth-code">
          {qrImage ? <img src={qrImage} alt="飞书本人授权二维码" /> : <div className="settings-qr-placeholder">{qrError ? "二维码生成失败，请使用链接" : "生成二维码…"}</div>}
          <div><p>扫码授权</p><a href={authUrl} target="_blank" rel="noreferrer">打开授权链接<ExternalLink aria-hidden="true" /></a></div>
        </div>}
        {state?.auth.error && <p role="alert" className="settings-detail-error">{state.auth.error}</p>}
        {Boolean(state?.auth.missingScopes?.length) && <p role="alert" className="settings-detail-error">缺少权限：{state?.auth.missingScopes?.join("、")}</p>}
        <details className="settings-permissions">
          <summary>应用权限</summary>
          <p>需开通并发布：contact:user:search、im:chat:read、im:message.send_as_user、im:message。</p>
          <a href="https://open.feishu.cn/app" target="_blank" rel="noreferrer">飞书开放平台<ExternalLink aria-hidden="true" /></a>
        </details>
      </section>

      <section className="settings-card settings-glass settings-hook-card" aria-labelledby="hook-title">
        <div className="settings-card-header">
          <span className="settings-card-icon"><Plug aria-hidden="true" /></span>
          <h2 id="hook-title">Codex Hook</h2>
          <span className={"settings-badge" + (state?.hook.capturedAt ? " is-good" : "")}>{hookStatus}</span>
        </div>
        <p className="settings-inline-status settings-hook-status" aria-live="polite" title={state?.hook.capturedAt ? "最近捕获：" + new Date(state.hook.capturedAt).toLocaleString("zh-CN") : undefined}>
          <span className="settings-status-icon"><Sparkles aria-hidden="true" /></span><span>{hookDetail}</span>
        </p>
        <label className="settings-hook-path">Codex 配置目录<input className={inputClass} value={codexHome} onChange={(event) => setCodexHome(event.target.value)} placeholder="~/.codex" spellCheck={false} /></label>
        <button type="button" className={buttonClass + " settings-button-primary settings-hook-button"} disabled={Boolean(busy) || !state} onClick={() => void perform("hook", () => window.electron.installHook({ codexHome: codexHome.trim() }), "Hook 已安装。请在 Codex 审阅并信任，再重启或重新加载会话。")}>{busy === "hook" && <LoaderCircle className="settings-spinner" aria-hidden="true" />}安装 / 更新 Hook</button>
        <p className={"settings-listener" + (state?.listener.status === "error" ? " is-error" : "")} aria-live="polite">{state?.listener.status === "listening" ? "剪贴板监听中" : state?.listener.status === "error" ? "剪贴板监听异常" : "剪贴板监听启动中"}</p>
        <p className="settings-hook-hint">安装后在 Codex 信任并重载</p>
        {state?.listener.error && <p role="alert" className="settings-detail-error">{state.listener.error}</p>}
      </section>
    </div>

    <section className="settings-runtime settings-glass" aria-labelledby="runtime-title">
      <h2 id="runtime-title"><Monitor aria-hidden="true" />后台运行</h2>
      <div className="settings-toggle-grid">
        <label className="settings-toggle" htmlFor="hide-dock">
          <Monitor aria-hidden="true" /><span>隐藏 Dock 图标</span>
          <input id="hide-dock" type="checkbox" checked={Boolean(state?.desktop.hideDock)} disabled={!state || Boolean(busy)} onChange={(event) => void perform("set-hide-dock", () => window.electron.setHideDock(event.target.checked), "程序坞显示设置已保存。")} />
        </label>
        <label className="settings-toggle" htmlFor="open-at-login">
          <Power aria-hidden="true" /><span>开机自启</span>
          <input id="open-at-login" type="checkbox" checked={Boolean(state?.desktop.openAtLogin)} disabled={!state?.desktop.loginAvailable || Boolean(busy)} aria-describedby="login-item-status" onChange={(event) => void perform("set-open-at-login", () => window.electron.setOpenAtLogin(event.target.checked), "登录自启设置已更新。")} />
        </label>
      </div>
      <p id="login-item-status" className="settings-runtime-note" aria-live="polite">{loginStatus}</p>
      {state?.desktop.loginStatus === "requires-approval" && <button className={buttonClass} type="button" onClick={() => {
        console.info("[settings-ui] action requested", { action: "open-login-settings" });
        window.electron.openLoginSettings();
      }}>打开 macOS 登录项设置</button>}
    </section>
  </main>;
}
