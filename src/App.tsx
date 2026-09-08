import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useId,
  type ReactNode,
} from "react";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  BookOpen,
  Check,
  CheckCheck,
  ChevronDown,
  Code2,
  Copy,
  Download,
  ExternalLink,
  FolderOpen,
  GitBranch,
  Github,
  Globe2,
  Info,
  Layers3,
  Link2,
  ListFilter,
  LockKeyhole,
  Network,
  Pencil,
  Plus,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  Smartphone,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  APP_CATALOG,
  createProfile,
  compileProfile,
  parseProfile,
  serializeProfile,
  validateDomain,
  fileName,
  type AppRule,
  type CustomRule,
  type Policy,
  type Profile,
} from "./core";

type Tab = "apps" | "basic" | "dns" | "advanced" | "chain";
type Saved = { id: string; savedAt: string; profile: Profile };
const STORAGE_KEY = "routekit.profiles.v1";
const labels: Record<Policy, string> = {
  DIRECT: "直连",
  PROXY: "代理",
  REJECT: "拦截",
};
const REPO_URL: string = import.meta.env.VITE_REPOSITORY_URL || "https://github.com/menghuaban520/routekit";

function PolicyControl({
  value,
  onChange,
  name,
  reject = true,
}: {
  value: Policy;
  onChange: (p: Policy) => void;
  name: string;
  reject?: boolean;
}) {
  return (
    <div className="policy-control" role="group" aria-label={name}>
      {(["DIRECT", "PROXY", ...(reject ? ["REJECT"] : [])] as Policy[]).map(
        (p) => (
          <button
            type="button"
            key={p}
            aria-pressed={value === p}
            className={value === p ? `selected ${p.toLowerCase()}` : ""}
            onClick={() => onChange(p)}
          >
            {labels[p]}
          </button>
        ),
      )}
    </div>
  );
}
function Note({
  children,
  warning = false,
}: {
  children: ReactNode;
  warning?: boolean;
}) {
  return (
    <div className={`note ${warning ? "warning" : ""}`}>
      <Info size={16} />
      <div>{children}</div>
    </div>
  );
}
function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  useEffect(() => {
    const dialog = ref.current!;
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    dialog.showModal();
    return () => {
      dialog.close();
      if (previousFocus?.isConnected)
        previousFocus.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={headingId}
      className={wide ? "wide-modal" : ""}
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const box = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < box.left ||
            event.clientX > box.right ||
            event.clientY < box.top ||
            event.clientY > box.bottom
          )
            onClose();
        }
      }}
    >
      <div className="modal-heading">
        <h2 id={headingId}>{title}</h2>
        <button className="icon-button" aria-label="关闭弹窗" onClick={onClose}>
          <X />
        </button>
      </div>
      <div className="modal-body">{children}</div>
    </dialog>
  );
}
function download(
  text: string,
  name: string,
  type = "text/plain;charset=utf-8",
) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function AppEditor({
  app,
  onSave,
  onClose,
}: {
  app?: AppRule;
  onSave: (app: AppRule) => void;
  onClose: () => void;
}) {
  const fieldId = useId();
  const [name, setName] = useState(app?.name ?? "");
  const [domains, setDomains] = useState(app?.domains.join("\n") ?? "");
  const [policy, setPolicy] = useState<Policy>(app?.policy ?? "DIRECT");
  const [error, setError] = useState("");
  function submit(event: React.FormEvent) {
    event.preventDefault();
    const items = [
      ...new Set(
        domains
          .split(/\r?\n/)
          .map((x) => x.trim().toLowerCase())
          .filter(Boolean),
      ),
    ];
    if (!name.trim() || name.trim().length > 60 || /[\r\n\[\]#]/.test(name))
      return setError("名称需为 1–60 个普通字符。");
    if (
      !items.length ||
      items.length > 100 ||
      items.some((d) => !validateDomain(d))
    )
      return setError(
        "请填写有效域名，每行一个，最多 100 个。不含 https://、路径、空格或通配符。",
      );
    onSave({
      id: app?.id ?? crypto.randomUUID(),
      name: name.trim(),
      domains: items,
      policy,
      color: app?.color ?? "#147d73",
      symbol: app?.symbol ?? name.trim().slice(0, 1),
      custom: true,
    });
  }
  return (
    <Modal title={app ? "编辑应用规则" : "添加自定义应用"} onClose={onClose}>
      <form onSubmit={submit} className="form-stack">
        <label>
          <span id={`${fieldId}-name`}>应用名称</span>
          <input
            aria-labelledby={`${fieldId}-name`}
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            placeholder="例如：我的音乐应用"
          />
        </label>
        <label>
          <span id={`${fieldId}-domains`}>应用域名</span>
          <textarea
            aria-labelledby={`${fieldId}-domains`}
            rows={5}
            value={domains}
            onChange={(e) => setDomains(e.target.value)}
            placeholder={"example.com\ncdn.example.net"}
            spellCheck={false}
          />
        </label>
        <p className="helper">
          每行一个域名，自动包含其子域名。应用可能需要多个域名；这里不按进程识别应用。
        </p>
        <div className="setting-row">
          <span>连接方式</span>
          <PolicyControl
            value={policy}
            name="自定义应用连接方式"
            onChange={setPolicy}
          />
        </div>
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
        <button className="button primary" type="submit">
          <Check size={18} />
          {app ? "保存应用规则" : "添加到分流"}
        </button>
      </form>
    </Modal>
  );
}

export default function App() {
  const [profile, setProfile] = useState<Profile>(createProfile);
  const [advanced, setAdvanced] = useState(false);
  const [tab, setTab] = useState<Tab>("apps");
  const [search, setSearch] = useState("");
  const [fullPreview, setFullPreview] = useState(false);
  const [modal, setModal] = useState<
    "catalog" | "custom" | "saved" | "guide" | null
  >(null);
  const [editing, setEditing] = useState<AppRule>();
  const [catalogSearch, setCatalogSearch] = useState("");
  const [message, setMessage] = useState("");
  const [saved, setSaved] = useState<Saved[]>([]);
  const [storageError, setStorageError] = useState("");
  const [lastSaved, setLastSaved] = useState("");
  const [savedState, setSavedState] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const result = useMemo(() => compileProfile(profile), [profile]);
  const profileState = JSON.stringify(profile);
  const ready = result.errors.length === 0;
  const compactRules = new Set([
    ...profile.apps.flatMap((app) =>
      app.domains.map((domain) => domain.toLowerCase()),
    ),
    ...profile.rules.map((rule) => rule.value.toLowerCase()),
  ]);
  const previewLines = result.content
    .split("\n")
    .map((line, index) => ({ line, index }))
    .filter(
      ({ line }) =>
        fullPreview ||
        line === "[General]" ||
        line === "[Rule]" ||
        line.startsWith("dns-server =") ||
        line.startsWith("ipv6 =") ||
        line.startsWith("FINAL,") ||
        line.startsWith("GEOIP,") ||
        compactRules.has(line.split(",")[1]),
    );
  const filteredApps = profile.apps.filter((a) =>
    `${a.name} ${a.domains.join(" ")}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const availableApps = APP_CATALOG.filter(
    (a) => !profile.apps.some((p) => p.id === a.id),
  );
  const visibleCatalog = APP_CATALOG.filter((a) =>
    `${a.name} ${a.domains.join(" ")}`
      .toLowerCase()
      .includes(catalogSearch.toLowerCase()),
  );

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(""), 4200);
    return () => clearTimeout(timer);
  }, [message]);
  function patch(changes: Partial<Profile>) {
    setProfile((p) => ({ ...p, ...changes }));
  }
  function changeApp(id: string, changes: Partial<AppRule>) {
    setProfile((p) => ({
      ...p,
      apps: p.apps.map((a) => (a.id === id ? { ...a, ...changes } : a)),
    }));
  }
  function addApp(app: AppRule) {
    if (profile.apps.some((a) => a.id === app.id)) return;
    patch({ apps: [...profile.apps, structuredClone(app)] });
    setMessage(`已添加 ${app.name}`);
  }
  function closeModal() {
    setModal(null);
    setEditing(undefined);
  }
  function readSaved(): Saved[] {
    const data: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(data) || data.length > 20)
      throw new Error(
        "本地方案格式不正确。请先备份当前方案，再检查浏览器存储。",
      );
    return data.map((item) => {
      if (
        !item ||
        typeof item.id !== "string" ||
        typeof item.savedAt !== "string" ||
        !Number.isFinite(Date.parse(item.savedAt))
      )
        throw new Error("本地方案已损坏，未覆盖原始数据。");
      return {
        id: item.id,
        savedAt: item.savedAt,
        profile: parseProfile(JSON.stringify(item.profile)),
      };
    });
  }
  function openSaved() {
    setStorageError("");
    try {
      setSaved(readSaved());
    } catch (error) {
      setSaved([]);
      setStorageError(
        error instanceof Error ? error.message : "浏览器存储不可用。",
      );
    }
    setModal("saved");
  }
  function saveLocal() {
    if (!ready) return;
    try {
      const data = readSaved();
      const same = data.findIndex((x) => x.profile.name === profile.name);
      const entry: Saved = {
        id: same >= 0 ? data[same].id : crypto.randomUUID(),
        savedAt: new Date().toISOString(),
        profile: structuredClone(profile),
      };
      if (same >= 0) data[same] = entry;
      else {
        if (data.length >= 20)
          throw new Error(
            "最多保存 20 个方案，请在“本地方案”中移除不需要的方案。",
          );
        data.unshift(entry);
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      setSaved(data);
      setLastSaved(
        new Date().toLocaleTimeString("zh-CN", {
          hour: "2-digit",
          minute: "2-digit",
        }),
      );
      setSavedState(profileState);
      setMessage("已保存到此浏览器，可从“本地方案”重新打开。");
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "保存失败：浏览器存储不可用，请导出方案备份。",
      );
    }
  }
  async function importBackup(file?: File) {
    if (!file) return;
    try {
      if (file.size > 512_000) throw new Error("方案文件不能超过 500 KB。");
      const imported = parseProfile(await file.text());
      setProfile(imported);
      setSearch("");
      setSavedState("");
      setLastSaved("");
      setMessage("方案已导入。可继续编辑，或另存到此浏览器。");
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "导入失败，请选择 RouteKit 的 JSON 方案备份。",
      );
    }
    if (fileInput.current) fileInput.current.value = "";
  }
  function moveRule(index: number, delta: number) {
    const rules = [...profile.rules];
    [rules[index], rules[index + delta]] = [rules[index + delta], rules[index]];
    patch({ rules });
  }
  function updateRule(id: string, value: Partial<CustomRule>) {
    patch({
      rules: profile.rules.map((r) => (r.id === id ? { ...r, ...value } : r)),
    });
  }

  return (
    <>
      <a className="skip-link" href="#workspace">
        跳到配置工作台
      </a>
      <header className="site-header">
        <div className="header-inner">
          <a className="brand" href="./" aria-label="RouteKit 首页">
            <GitBranch size={31} strokeWidth={2.1} />
            <strong>RouteKit</strong>
            <span>分流工坊</span>
          </a>
          <nav aria-label="帮助与项目">
            <button onClick={() => setModal("guide")} className="text-button">
              <BookOpen size={18} />
              <span>新手指南</span>
            </button>
            {REPO_URL ? (
              <a
                className="text-button"
                href={REPO_URL}
                target="_blank"
                rel="noreferrer"
              >
                <Github size={19} />
                <span>GitHub</span>
              </a>
            ) : (
              <button className="text-button" onClick={() => setModal("guide")}>
                <Github size={19} />
                <span>开源说明</span>
              </button>
            )}
            <div className="privacy">
              <ShieldCheck size={23} />
              <span>
                本地处理<small>配置只在你的浏览器生成</small>
              </span>
            </div>
          </nav>
        </div>
      </header>
      <main className="page" id="workspace">
        <section className="intro">
          <div>
            <h1>让每个应用，走对的路。</h1>
            <p>选应用、定分流，生成属于你的 Shadowrocket 配置。</p>
          </div>
          <div className="mode-switch" role="group" aria-label="编辑模式">
            <button
              aria-pressed={!advanced}
              onClick={() => {
                setAdvanced(false);
                if (tab === "advanced") setTab("apps");
              }}
            >
              新手模式
            </button>
            <button aria-pressed={advanced} onClick={() => setAdvanced(true)}>
              <Code2 size={16} />
              高级模式
            </button>
          </div>
        </section>
        <div className="client-toolbar">
          <div className="client-choice">
            <span>选择客户端</span>
            <div className="client-tag">
              <Smartphone size={19} />
              Shadowrocket
              <Check size={15} />
            </div>
            <span className="upcoming">Clash、v2rayN 后续支持</span>
          </div>
          <button className="text-button" onClick={openSaved}>
            <FolderOpen size={17} />
            本地方案
          </button>
        </div>
        <div className="workspace-grid">
          <section className="editor-panel" aria-label="配置编辑器">
            <div className="tabs" role="tablist" aria-label="配置分类">
              {(
                [
                  { id: "basic", label: "基础设置", icon: Settings2 },
                  { id: "apps", label: "应用分流", icon: Layers3 },
                  { id: "dns", label: "DNS 保护", icon: ShieldCheck },
                  { id: "chain", label: "链式代理", icon: Link2 },
                  ...(advanced
                    ? [{ id: "advanced", label: "自定义", icon: Code2 }]
                    : []),
                ] as const
              ).map((item) => (
                <button
                  key={item.id}
                  id={`tab-${item.id}`}
                  role="tab"
                  aria-selected={tab === item.id}
                  aria-controls="editor-content"
                  tabIndex={tab === item.id ? 0 : -1}
                  onKeyDown={(event) => {
                    const buttons = Array.from(
                      event.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>(
                        '[role="tab"]',
                      ),
                    );
                    const index = buttons.indexOf(event.currentTarget);
                    const next =
                      event.key === "ArrowRight"
                        ? (index + 1) % buttons.length
                        : event.key === "ArrowLeft"
                          ? (index - 1 + buttons.length) % buttons.length
                          : event.key === "Home"
                            ? 0
                            : event.key === "End"
                              ? buttons.length - 1
                              : -1;
                    if (next >= 0) {
                      event.preventDefault();
                      buttons[next].focus();
                      buttons[next].click();
                    }
                  }}
                  onClick={() => setTab(item.id as Tab)}
                >
                  <item.icon size={18} />
                  {item.label}
                </button>
              ))}
            </div>
            <div
              id="editor-content"
              className="editor-body"
              role="tabpanel"
              aria-labelledby={`tab-${tab}`}
            >
              {tab === "apps" && (
                <>
                  <div className="section-heading">
                    <h2>应用怎么连接，由你决定</h2>
                    <p>直连使用本地网络，代理使用你在小火箭选择的节点。</p>
                  </div>
                  <div className="app-toolbar">
                    <div className="search-field">
                      <Search size={18} />
                      <input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="搜索已选应用或域名"
                        aria-label="搜索已选应用"
                      />
                      {search && (
                        <button
                          className="icon-button small"
                          onClick={() => setSearch("")}
                          aria-label="清空搜索"
                        >
                          <X size={15} />
                        </button>
                      )}
                    </div>
                    <button
                      className="button outline add-custom"
                      onClick={() => {
                        setEditing(undefined);
                        setModal("custom");
                      }}
                    >
                      <Plus size={18} />
                      <span>自定义应用</span>
                    </button>
                  </div>
                  <div className="app-list">
                    {filteredApps.map((app) => (
                      <div
                        className="app-row"
                        key={app.id}
                        data-testid={`app-${app.id}`}
                      >
                        <div
                          className="app-avatar"
                          style={{ background: app.color }}
                        >
                          {app.symbol}
                        </div>
                        <button
                          className="app-details"
                          onClick={() => {
                            setEditing(app);
                            setModal("custom");
                          }}
                          aria-label={`编辑 ${app.name}`}
                        >
                          <strong>
                            {app.name}
                            {app.custom && (
                              <span className="custom-label">自定义</span>
                            )}
                          </strong>
                          <small title={app.domains.join(", ")}>
                            {app.domains[0]}
                            {app.domains.length > 1
                              ? ` + ${app.domains.length - 1} 个域名`
                              : ""}
                          </small>
                        </button>
                        <PolicyControl
                          value={app.policy}
                          name={`${app.name}连接方式`}
                          onChange={(p) => changeApp(app.id, { policy: p })}
                        />
                        <button
                          className="icon-button delete-app"
                          aria-label={`移除 ${app.name}`}
                          onClick={() =>
                            patch({
                              apps: profile.apps.filter((a) => a.id !== app.id),
                            })
                          }
                        >
                          <Trash2 size={17} />
                        </button>
                      </div>
                    ))}
                    {!filteredApps.length && (
                      <div className="empty-state">
                        <Search size={28} />
                        <strong>
                          {search ? "没有匹配的已选应用" : "从一个常用应用开始"}
                        </strong>
                        <p>
                          {search
                            ? "试试其他关键词，或添加自定义应用。"
                            : "没有单独设置的应用，会遵循基础设置中的默认连接方式。"}
                        </p>
                        <button
                          className="button outline"
                          onClick={() => {
                            setCatalogSearch(search);
                            setModal("catalog");
                          }}
                        >
                          浏览应用库
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="quick-add">
                    <button
                      className="text-button accent"
                      onClick={() => {
                        setCatalogSearch("");
                        setModal("catalog");
                      }}
                    >
                      <Plus size={18} />
                      添加应用
                    </button>
                    <span className="quick-label">快速添加</span>
                    <div className="chips">
                      {availableApps.slice(0, 4).map((app) => (
                        <button key={app.id} onClick={() => addApp(app)}>
                          {app.name}
                        </button>
                      ))}
                      {!availableApps.length && (
                        <span className="helper">内置应用已全部添加</span>
                      )}
                    </div>
                  </div>
                  <Note>
                    按域名分流，内置域名是起点。点击应用名称可补充域名；共享域名会影响多个应用。
                  </Note>
                </>
              )}
              {tab === "basic" && (
                <>
                  <div className="section-heading">
                    <h2>先选一个适合你的连接方式</h2>
                    <p>应用和自定义规则优先，下面的设置负责其余流量。</p>
                  </div>
                  <fieldset className="preset-options">
                    <legend>快捷方案</legend>
                    {[
                      {
                        name: "日常分流",
                        text: "国内直连，其他代理",
                        domestic: "DIRECT",
                        final: "PROXY",
                        icon: Network,
                      },
                      {
                        name: "默认代理",
                        text: "国内和其他均走代理",
                        domestic: "PROXY",
                        final: "PROXY",
                        icon: Globe2,
                      },
                      {
                        name: "默认直连",
                        text: "需要代理的应用单独设",
                        domestic: "DIRECT",
                        final: "DIRECT",
                        icon: ArrowRight,
                      },
                    ].map((preset) => (
                      <button
                        key={preset.name}
                        className={
                          profile.domesticPolicy === preset.domestic &&
                          profile.finalPolicy === preset.final
                            ? "preset active"
                            : "preset"
                        }
                        onClick={() =>
                          patch({
                            domesticPolicy: preset.domestic as
                              "DIRECT" | "PROXY",
                            finalPolicy: preset.final as "DIRECT" | "PROXY",
                          })
                        }
                      >
                        <preset.icon size={21} />
                        <strong>{preset.name}</strong>
                        <small>{preset.text}</small>
                      </button>
                    ))}
                  </fieldset>
                  <div className="settings-list">
                    <div className="setting-row">
                      <div>
                        <strong>国内 IP 的连接方式</strong>
                        <p>通过客户端的 GEOIP CN 数据识别。</p>
                      </div>
                      <PolicyControl
                        reject={false}
                        value={profile.domesticPolicy}
                        name="国内连接方式"
                        onChange={(p) =>
                          patch({ domesticPolicy: p as "DIRECT" | "PROXY" })
                        }
                      />
                    </div>
                    <div className="setting-row">
                      <div>
                        <strong>其他流量的连接方式</strong>
                        <p>没有命中前面规则时，使用此设置。</p>
                      </div>
                      <PolicyControl
                        reject={false}
                        value={profile.finalPolicy}
                        name="其他流量连接方式"
                        onChange={(p) =>
                          patch({ finalPolicy: p as "DIRECT" | "PROXY" })
                        }
                      />
                    </div>
                    <label className="setting-row">
                      <div>
                        <strong>局域网保持直连</strong>
                        <p>优先连接打印机、路由器和本地设备。</p>
                      </div>
                      <input
                        className="switch"
                        type="checkbox"
                        checked={profile.bypassLan}
                        onChange={(e) => patch({ bypassLan: e.target.checked })}
                        role="switch"
                      />
                    </label>
                  </div>
                  <Note>
                    “代理”不会自动提供中国或海外节点。需要哪个地区的出口，请先在小火箭选择对应节点；直连始终使用你当前所在地的网络。
                  </Note>
                </>
              )}
              {tab === "dns" && (
                <>
                  <div className="section-heading">
                    <h2>给域名解析，多一层保护</h2>
                    <p>设置解析方式，并在客户端连接后验证实际效果。</p>
                  </div>
                  <div
                    className="dns-options"
                    role="group"
                    aria-label="DNS 解析方式"
                  >
                    {[
                      {
                        id: "encrypted",
                        title: "加密 DNS",
                        text: "使用 DNS over HTTPS，减少明文解析。",
                        icon: LockKeyhole,
                      },
                      {
                        id: "system",
                        title: "系统 DNS",
                        text: "使用当前网络提供的解析服务。",
                        icon: Settings2,
                      },
                      {
                        id: "custom",
                        title: "自定义 DNS",
                        text: "填写你信任的 DNS 服务器。",
                        icon: Pencil,
                      },
                    ].map((option) => (
                      <button
                        key={option.id}
                        className={
                          profile.dns.mode === option.id
                            ? "dns-option active"
                            : "dns-option"
                        }
                        aria-pressed={profile.dns.mode === option.id}
                        onClick={() =>
                          patch({
                            dns: {
                              ...profile.dns,
                              mode: option.id as Profile["dns"]["mode"],
                            },
                          })
                        }
                      >
                        <option.icon size={22} />
                        <span>
                          <strong>{option.title}</strong>
                          <small>{option.text}</small>
                        </span>
                        <span className="radio-dot" />
                      </button>
                    ))}
                  </div>
                  {profile.dns.mode === "encrypted" && (
                    <div className="resolver-info">
                      <LockKeyhole size={17} />
                      <div>
                        <strong>阿里 DNS + DNSPod · 加密主备</strong>
                        <code>dns.alidns.com / doh.pub</code>
                        <small>
                          两者使用 HTTPS 解析；不自动回退到系统 DNS。
                        </small>
                      </div>
                    </div>
                  )}
                  {profile.dns.mode === "custom" && (
                    <label className="field-label">
                      DNS 服务器
                      <textarea
                        rows={3}
                        value={profile.dns.servers}
                        onChange={(e) =>
                          patch({
                            dns: { ...profile.dns, servers: e.target.value },
                          })
                        }
                        placeholder={
                          "https://1.1.1.1/dns-query\nhttps://dns.google/dns-query"
                        }
                        spellCheck={false}
                      />
                      <span className="helper">
                        每行一个 HTTPS DoH 地址或 IP 地址。IP 形式仍是明文 DNS。
                      </span>
                    </label>
                  )}
                  <label className="setting-row">
                    <div>
                      <strong>启用 IPv6</strong>
                      <p>仅在你的网络与代理都支持时开启。</p>
                    </div>
                    <input
                      className="switch"
                      type="checkbox"
                      role="switch"
                      checked={profile.dns.ipv6}
                      onChange={(e) =>
                        patch({
                          dns: { ...profile.dns, ipv6: e.target.checked },
                        })
                      }
                    />
                  </label>
                  <Note warning>
                    加密 DNS 不代表已消除泄漏。浏览器自己的
                    DoH、IPv6、客户端设置和节点能力都可能改变解析路径。本网页不检测你设备的真实
                    DNS 流量。
                  </Note>
                  <details className="guide-details">
                    <summary>
                      连接之后，怎样检查？
                      <ChevronDown size={16} />
                    </summary>
                    <ol>
                      <li>
                        导入并启用配置，在小火箭中选择“配置”路由模式后连接。
                      </li>
                      <li>查看客户端 DNS 日志，确认解析服务器与设置相符。</li>
                      <li>
                        使用可信的 DNS
                        泄漏测试网站，对比断开与连接后的结果；单次测试不能证明所有应用都无泄漏。
                      </li>
                      <li>
                        出现异常时，检查浏览器安全 DNS、IPv6 和节点的 UDP 支持。
                      </li>
                    </ol>
                  </details>
                </>
              )}
              {tab === "chain" && (
                <>
                  <div className="section-heading">
                    <h2>先经过前置节点，再到出口</h2>
                    <p>分流决定哪些流量走代理，链式代理决定它怎么到达出口。</p>
                  </div>
                  <div className="chain-diagram">
                    <div>
                      <Smartphone />
                      <strong>你的设备</strong>
                      <small>发起连接</small>
                    </div>
                    <ArrowRight />
                    <div>
                      <Network />
                      <strong>前置节点</strong>
                      <small>负责中转</small>
                    </div>
                    <ArrowRight />
                    <div>
                      <Globe2 />
                      <strong>出口节点</strong>
                      <small>目标看到的 IP</small>
                    </div>
                  </div>
                  <div className="step-list">
                    <div>
                      <span>1</span>
                      <section>
                        <h3>在小火箭添加两个节点</h3>
                        <p>
                          准备可用的前置节点和出口节点，先分别验证它们的连接状态。
                        </p>
                      </section>
                    </div>
                    <div>
                      <span>2</span>
                      <section>
                        <h3>为出口设置 Proxy Pass</h3>
                        <p>
                          编辑出口节点，在“代理通过 / Proxy
                          Pass”中选择前置节点。入口名称和支持情况取决于客户端版本与节点协议。
                        </p>
                      </section>
                    </div>
                    <div>
                      <span>3</span>
                      <section>
                        <h3>选择出口节点，启用本页配置</h3>
                        <p>
                          将主页所选节点设为出口，再启用分流配置。配置中的 PROXY
                          会使用这个选择。
                        </p>
                      </section>
                    </div>
                    <div>
                      <span>4</span>
                      <section>
                        <h3>确认真正走通了整条链</h3>
                        <p>
                          检查连通性、出口 IP
                          和持续访问。节点已保存或延迟测试成功，都不能单独证明链路正常。
                        </p>
                      </section>
                    </div>
                  </div>
                  <label className="setting-row">
                    <div>
                      <strong>前置节点缺失时停止连接</strong>
                      <p>避免在中转节点被删除后意外直连出口。需客户端支持。</p>
                    </div>
                    <input
                      className="switch"
                      type="checkbox"
                      role="switch"
                      checked={/^close-if-proxy-chain-missing\s*=\s*true$/m.test(
                        profile.general,
                      )}
                      onChange={(e) =>
                        patch({
                          general: [
                            ...profile.general
                              .split(/\r?\n/)
                              .filter(
                                (line) =>
                                  !/^\s*close-if-proxy-chain-missing\s*=/.test(
                                    line,
                                  ),
                              ),
                            `close-if-proxy-chain-missing = ${e.target.checked}`,
                          ]
                            .filter(Boolean)
                            .join("\n"),
                        })
                      }
                    />
                  </label>
                  <Note>
                    链式关系需要在客户端配置，本页不写入节点与密码，也不会把教程步骤伪装成已配置成功。导出的
                    .conf 只控制分流与 DNS。
                  </Note>
                </>
              )}
              {tab === "advanced" && advanced && (
                <>
                  <div className="section-heading">
                    <h2>规则的每一个细节，都能调整</h2>
                    <p>
                      从上到下匹配。以下规则优先于应用规则，局域网直连除外。
                    </p>
                  </div>
                  <div className="rules-heading">
                    <strong>
                      <ListFilter size={17} />
                      自定义规则{" "}
                      <span className="count">{profile.rules.length}</span>
                    </strong>
                    <button
                      className="button outline compact"
                      onClick={() =>
                        patch({
                          rules: [
                            ...profile.rules,
                            {
                              id: crypto.randomUUID(),
                              type: "DOMAIN-SUFFIX",
                              value: "",
                              policy: "DIRECT",
                            },
                          ],
                        })
                      }
                    >
                      <Plus size={16} />
                      添加规则
                    </button>
                  </div>
                  <div className="custom-rules">
                    {profile.rules.map((rule, index) => (
                      <div className="rule-row" key={rule.id}>
                        <span className="rule-number">{index + 1}</span>
                        <select
                          aria-label={`规则 ${index + 1} 类型`}
                          value={rule.type}
                          onChange={(e) =>
                            updateRule(rule.id, {
                              type: e.target.value as CustomRule["type"],
                            })
                          }
                        >
                          <option>DOMAIN-SUFFIX</option>
                          <option>DOMAIN</option>
                          <option>DOMAIN-KEYWORD</option>
                          <option>IP-CIDR</option>
                          <option>IP-CIDR6</option>
                        </select>
                        <input
                          aria-label={`规则 ${index + 1} 值`}
                          value={rule.value}
                          placeholder={
                            rule.type.startsWith("IP")
                              ? "10.0.0.0/8"
                              : "example.com"
                          }
                          onChange={(e) =>
                            updateRule(rule.id, { value: e.target.value })
                          }
                          spellCheck={false}
                        />
                        <select
                          aria-label={`规则 ${index + 1} 策略`}
                          value={rule.policy}
                          onChange={(e) =>
                            updateRule(rule.id, {
                              policy: e.target.value as Policy,
                            })
                          }
                        >
                          {Object.entries(labels).map(([key, label]) => (
                            <option key={key} value={key}>
                              {label}
                            </option>
                          ))}
                        </select>
                        <div className="rule-actions">
                          <button
                            className="icon-button small"
                            aria-label={`上移规则 ${index + 1}`}
                            disabled={index === 0}
                            onClick={() => moveRule(index, -1)}
                          >
                            <ArrowUp size={15} />
                          </button>
                          <button
                            className="icon-button small"
                            aria-label={`下移规则 ${index + 1}`}
                            disabled={index === profile.rules.length - 1}
                            onClick={() => moveRule(index, 1)}
                          >
                            <ArrowDown size={15} />
                          </button>
                          <button
                            className="icon-button small"
                            aria-label={`删除规则 ${index + 1}`}
                            onClick={() =>
                              patch({
                                rules: profile.rules.filter(
                                  (r) => r.id !== rule.id,
                                ),
                              })
                            }
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </div>
                    ))}
                    {!profile.rules.length && (
                      <p className="empty-rules">
                        还没有自定义规则。可以添加域名、关键词或 IP 网段。
                      </p>
                    )}
                  </div>
                  <label className="field-label advanced-field">
                    Hosts 映射
                    <span className="helper">
                      为指定域名指定 IP，每行一条。不会请求远端 Hosts 文件。
                    </span>
                    <textarea
                      rows={3}
                      value={profile.hosts}
                      onChange={(e) => patch({ hosts: e.target.value })}
                      placeholder="example.com = 192.0.2.1"
                      spellCheck={false}
                    />
                  </label>
                  <label className="field-label advanced-field">
                    General 扩展设置
                    <span className="helper">
                      支持
                      icmp-auto-reply、always-reject-url-rewrite、private-ip-answer、use-local-host-item-for-proxy、close-if-proxy-chain-missing，值为
                      true / false。DNS 与 IPv6 在上方设置。
                    </span>
                    <textarea
                      rows={4}
                      value={profile.general}
                      onChange={(e) => patch({ general: e.target.value })}
                      placeholder="close-if-proxy-chain-missing = true"
                      spellCheck={false}
                    />
                  </label>
                  <Note>
                    非法字段和冲突会在右侧显示并阻止导出。切回新手模式会保留所有高级设置。
                  </Note>
                </>
              )}
            </div>
          </section>
          <aside className="preview-panel" aria-label="配置预览">
            <div className="preview-heading">
              <h2>配置预览</h2>
              <span className={`status ${ready ? "" : "invalid"}`}>
                <i />
                {ready ? "可导出" : "需要修改"}
              </span>
            </div>
            <dl className="config-summary">
              <div>
                <dt>
                  <Globe2 size={17} />
                  国内 IP
                </dt>
                <dd>{labels[profile.domesticPolicy]}</dd>
              </div>
              <div>
                <dt>
                  <Network size={17} />
                  其他流量
                </dt>
                <dd>{labels[profile.finalPolicy]}</dd>
              </div>
              <div>
                <dt>
                  <LockKeyhole size={17} />
                  DNS
                </dt>
                <dd>
                  {profile.dns.mode === "encrypted"
                    ? "加密解析"
                    : profile.dns.mode === "system"
                      ? "系统解析"
                      : "自定义"}
                </dd>
              </div>
            </dl>
            <div className="code-window">
              <div className="code-toolbar">
                <span>
                  <Code2 size={14} />
                  {fullPreview ? "Shadowrocket .conf" : "关键规则"}
                </span>
                <button
                  className="preview-toggle"
                  aria-pressed={fullPreview}
                  onClick={() => setFullPreview(!fullPreview)}
                >
                  {fullPreview ? "精简预览" : "完整配置"}
                </button>
                <button
                  className="icon-button small"
                  title="复制配置"
                  aria-label="复制配置"
                  disabled={!ready}
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(result.content);
                      setMessage("配置已复制。");
                    } catch {
                      setMessage("浏览器未允许复制，请使用“下载 .conf”。");
                    }
                  }}
                >
                  <Copy size={15} />
                </button>
              </div>
              <pre tabIndex={0} aria-label="生成的配置内容">
                {previewLines.map(({ line, index: i }) => (
                  <div
                    key={i}
                    className={
                      line.startsWith("#")
                        ? "code-comment"
                        : line.startsWith("[")
                          ? "code-section"
                          : ""
                    }
                  >
                    <span className="line-number" aria-hidden="true">
                      {i + 1}
                    </span>
                    <code>{line || " "}</code>
                  </div>
                ))}
              </pre>
              <div className="code-footer">
                <span>下载包含全部 {result.ruleCount} 条规则</span>
                <span>{fullPreview ? "UTF-8" : "通用设置已折叠"}</span>
              </div>
            </div>
            {!!result.errors.length && (
              <div className="validation-errors" role="alert">
                <strong>修改后即可导出</strong>
                <ul>
                  {result.errors.map((error, i) => (
                    <li key={i}>{error}</li>
                  ))}
                </ul>
              </div>
            )}
            <label className="filename-label">
              方案名称
              <div className="filename-field">
                <input
                  value={profile.name}
                  onChange={(e) => patch({ name: e.target.value })}
                  maxLength={60}
                  aria-label="方案名称"
                  placeholder="my-routes"
                />
                <span>.conf</span>
              </div>
            </label>
            <div className="export-actions">
              <button
                className="button primary download-button"
                disabled={!ready}
                onClick={() => {
                  download(result.content, `${fileName(profile.name)}.conf`);
                  setMessage("已发起 .conf 下载，请在浏览器下载列表查看。");
                }}
              >
                <Download size={19} />
                下载 .conf
              </button>
              <button
                className="button outline"
                disabled={!ready}
                onClick={saveLocal}
              >
                <Save size={18} />
                保存到本地
              </button>
            </div>
            <p className="save-hint">
              {lastSaved && savedState === profileState ? (
                <>
                  <CheckCheck size={15} />
                  {lastSaved} 已保存到此浏览器
                </>
              ) : (
                <>
                  <Info size={15} />
                  {lastSaved ? "有修改尚未保存" : "仅在点击保存时写入此浏览器"}
                </>
              )}
            </p>
            <div className="backup-actions">
              <button
                className="text-button"
                disabled={!ready}
                onClick={() => {
                  download(
                    serializeProfile(profile),
                    `${fileName(profile.name)}.routekit.json`,
                    "application/json",
                  );
                  setMessage("已发起方案备份下载。");
                }}
              >
                <Download size={14} />
                导出方案备份
              </button>
              <button
                className="text-button"
                onClick={() => fileInput.current?.click()}
              >
                <Upload size={14} />
                导入方案
              </button>
              <input
                ref={fileInput}
                type="file"
                accept=".json,application/json"
                className="visually-hidden"
                aria-label="导入 JSON 方案备份"
                onChange={(e) => void importBackup(e.target.files?.[0])}
              />
            </div>
            {!!result.warnings.length && (
              <details className="preview-notes">
                <summary>
                  <Info size={14} />
                  使用提醒（{result.warnings.length}）<ChevronDown size={14} />
                </summary>
                <ul>
                  {result.warnings.map((warning, i) => (
                    <li key={i}>{warning}</li>
                  ))}
                </ul>
              </details>
            )}
            <button
              className="import-help text-button accent"
              onClick={() => setModal("guide")}
            >
              下载之后，怎么导入小火箭？
              <ArrowRight size={15} />
            </button>
          </aside>
        </div>
      </main>
      <footer className="site-footer">
        <span>为自己的网络做主。</span>
        <div>
          <button onClick={() => setModal("guide")}>使用指南</button>
          <span>·</span>
          <span>MIT License</span>
          <span className="version">v0.1.0</span>
        </div>
      </footer>
      {message && (
        <div className="toast" role="status">
          <Info size={17} />
          <span>{message}</span>
          <button
            className="icon-button small"
            onClick={() => setMessage("")}
            aria-label="关闭提示"
          >
            <X size={16} />
          </button>
        </div>
      )}
      {modal === "custom" && (
        <AppEditor
          app={editing}
          onClose={closeModal}
          onSave={(app) => {
            if (editing) changeApp(editing.id, app);
            else addApp(app);
            closeModal();
          }}
        />
      )}
      {modal === "catalog" && (
        <Modal title="添加常用应用" onClose={closeModal}>
          <div className="search-field catalog-search">
            <Search size={18} />
            <input
              autoFocus
              aria-label="搜索应用库"
              placeholder="搜索名称或域名"
              value={catalogSearch}
              onChange={(e) => setCatalogSearch(e.target.value)}
            />
          </div>
          <p className="helper">
            内置基础域名可继续编辑，不保证覆盖应用的所有请求。
          </p>
          <div className="catalog-list">
            {visibleCatalog.map((app) => {
              const included = profile.apps.some((a) => a.id === app.id);
              return (
                <button
                  key={app.id}
                  className="catalog-app"
                  disabled={included}
                  onClick={() => addApp(app)}
                >
                  <span
                    className="app-avatar"
                    style={{ background: app.color }}
                  >
                    {app.symbol}
                  </span>
                  <span>
                    <strong>{app.name}</strong>
                    <small>
                      {app.domains.length} 个基础域名 · 默认{labels[app.policy]}
                    </small>
                  </span>
                  {included ? <Check size={18} /> : <Plus size={18} />}
                </button>
              );
            })}
            {!visibleCatalog.length && (
              <p className="empty-rules">没有找到。可以自己添加应用和域名。</p>
            )}
          </div>
          <button
            className="button outline full-width"
            onClick={() => {
              setEditing(undefined);
              setModal("custom");
            }}
          >
            <Plus size={17} />
            添加自定义应用
          </button>
        </Modal>
      )}
      {modal === "saved" && (
        <Modal title="保存在此浏览器的方案" onClose={closeModal}>
          {storageError ? (
            <Note warning>{storageError}</Note>
          ) : (
            <>
              <p className="helper">
                同名保存会更新原方案。清理浏览器数据会移除这些方案，请定期导出备份。
              </p>
              {saved.length ? (
                <div className="saved-list">
                  {saved.map((item) => (
                    <div className="saved-row" key={item.id}>
                      <FolderOpen size={21} />
                      <div>
                        <strong>{item.profile.name}</strong>
                        <small>
                          {new Date(item.savedAt).toLocaleString("zh-CN")} ·{" "}
                          {item.profile.apps.length} 个应用
                        </small>
                      </div>
                      <button
                        className="button outline compact"
                        onClick={() => {
                          setProfile(structuredClone(item.profile));
                          setSavedState(JSON.stringify(item.profile));
                          setLastSaved(
                            new Date(item.savedAt).toLocaleTimeString("zh-CN", {
                              hour: "2-digit",
                              minute: "2-digit",
                            }),
                          );
                          setSearch("");
                          closeModal();
                          setMessage(`已打开 ${item.profile.name}`);
                        }}
                      >
                        打开
                      </button>
                      <button
                        className="icon-button"
                        aria-label={`删除方案 ${item.profile.name}`}
                        onClick={() => {
                          try {
                            const next = readSaved().filter(
                              (x) => x.id !== item.id,
                            );
                            localStorage.setItem(
                              STORAGE_KEY,
                              JSON.stringify(next),
                            );
                            setSaved(next);
                            setMessage("已删除本地方案，当前编辑内容仍保留。");
                          } catch {
                            setStorageError("删除失败：浏览器存储不可用。");
                          }
                        }}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="empty-state">
                  <FolderOpen size={30} />
                  <strong>还没有保存的方案</strong>
                  <p>在右侧点击“保存到本地”，下次就能从这里找回。</p>
                </div>
              )}
            </>
          )}
          <button
            className="button outline full-width"
            onClick={() => {
              closeModal();
              fileInput.current?.click();
            }}
          >
            <Upload size={17} />从 JSON 备份导入
          </button>
        </Modal>
      )}
      {modal === "guide" && (
        <Modal title="几步，让配置开始工作" onClose={closeModal} wide>
          <div className="guide-intro">
            <ShieldCheck size={27} />
            <p>
              RouteKit
              是一个本地配置生成器。它不提供代理节点，也不需要你的密码或订阅链接。
            </p>
          </div>
          <div className="step-list">
            <div>
              <span>1</span>
              <section>
                <h3>选择默认连接方式</h3>
                <p>
                  在基础设置选择国内与其他流量的去向。直连使用当前所在地网络；代理使用客户端所选节点。
                </p>
              </section>
            </div>
            <div>
              <span>2</span>
              <section>
                <h3>给常用应用设定分流</h3>
                <p>
                  添加酷狗、网易云或自定义应用。应用规则优先于国内与默认规则；共用域名可能同时影响其他应用。
                </p>
              </section>
            </div>
            <div>
              <span>3</span>
              <section>
                <h3>下载并导入 .conf</h3>
                <p>
                  点击“下载
                  .conf”，在小火箭的“配置”页使用本地文件导入，或从系统文件的分享菜单交给小火箭。入口可能随版本不同。
                </p>
              </section>
            </div>
            <div>
              <span>4</span>
              <section>
                <h3>启用配置，选择节点，再验证</h3>
                <p>
                  启用导入的配置，将全局路由设为“配置”，在主页选择已拥有的可用节点后连接。实际测试应用访问、出口
                  IP 与 DNS。
                </p>
              </section>
            </div>
          </div>
          <div className="guide-bottom">
            <h3>保存与继续编辑</h3>
            <p>
              “保存到本地”写入此浏览器；“导出方案备份”下载可再次编辑的
              JSON。支持导入 RouteKit JSON 备份，暂不反向解析任意 .conf。
            </p>
            <h3>开源与后续客户端</h3>
            <p>
              代码采用 MIT License。首版支持 Shadowrocket；Clash / Mihomo 与
              v2rayN 将通过独立适配器接入。生成器没有遥测、外部规则下载或后端。
            </p>
            {REPO_URL && (
              <a
                className="text-button accent"
                href={REPO_URL}
                target="_blank"
                rel="noreferrer"
              >
                查看 GitHub 源代码
                <ExternalLink size={14} />
              </a>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
