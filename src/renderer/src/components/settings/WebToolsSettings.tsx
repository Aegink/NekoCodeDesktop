import { useEffect, useState } from "react";
import {
	isAccountSearchEngine,
	isKeyedSearchEngine,
	SEARCH_ENGINES,
	type SearchEngineId,
	type WebToolsStatus,
	type WebToolsUpdate,
} from "../../../../shared/web-tools";
import { api, errorMessage } from "../../api";
import { useTranslation, type TranslationKey } from "../../i18n";
import { CustomizeIcon } from "../../lib/icons";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsDialog } from "./SettingsDialog";
import { SettingsRow } from "./SettingsRow";

const providerLabel = (id: SearchEngineId) => `webTools.provider.${id}` as TranslationKey;
const providerHint = (id: SearchEngineId) => `webTools.provider.${id}.hint` as TranslationKey;

/** Why searches will not reach the chosen service, or null when they will. */
function gap(status: WebToolsStatus): TranslationKey | null {
	if (isKeyedSearchEngine(status.provider)) return status.keys[status.provider] ? null : "webTools.keyMissing";
	if (isAccountSearchEngine(status.provider)) return status.accounts[status.provider] ? null : "webTools.accountMissing";
	if (status.provider === "searxng") return status.searxngUrl ? null : "webTools.urlMissing";
	return null;
}

/**
 * Where `web_search` is pointed.
 *
 * Keys are write-only from here: the dialog learns whether one is saved, never
 * what it is, so an empty field means "keep it" and removal is its own button.
 */
function WebSearchDialog({
	status,
	busy,
	error,
	onClose,
	onSave,
}: {
	status: WebToolsStatus;
	busy: boolean;
	error: string | null;
	onClose: () => void;
	onSave: (patch: WebToolsUpdate) => void;
}) {
	const { t } = useTranslation();
	const [provider, setProvider] = useState<SearchEngineId>(status.provider);
	const [key, setKey] = useState("");
	const [searxngUrl, setSearxngUrl] = useState(status.searxngUrl ?? "");
	const keyed = isKeyedSearchEngine(provider) ? provider : null;
	const saved = keyed ? status.keys[keyed] : false;

	const save = () => {
		const patch: WebToolsUpdate = { provider };
		if (keyed && key.trim()) patch.keys = { [keyed]: key.trim() };
		if (provider === "searxng") patch.searxngUrl = searxngUrl.trim() || null;
		onSave(patch);
	};

	return (
		<SettingsDialog
			title={t("webTools.dialogTitle")}
			description={t("webTools.dialogDescription")}
			onClose={onClose}
			footer={
				<>
					<Button onClick={onClose} size="sm" variant="ghost">
						{t("common.cancel")}
					</Button>
					<Button disabled={busy} onClick={save} size="sm" variant="subtle">
						{t("common.save")}
					</Button>
				</>
			}
		>
			<div className="flex flex-col gap-1">
				<Label>{t("webTools.provider")}</Label>
				<Select
					value={provider}
					onValueChange={(next) => {
						if (!next) return;
						setProvider(next as SearchEngineId);
						setKey("");
					}}
				>
					<SelectTrigger size="sm">
						<SelectValue>{t(providerLabel(provider))}</SelectValue>
					</SelectTrigger>
					<SelectPopup surface="settings">
						{SEARCH_ENGINES.map((id) => (
							<SelectItem key={id} value={id}>
								{t(providerLabel(id))}
								{isKeyedSearchEngine(id) && status.keys[id] ? ` · ${t("webTools.keySaved")}` : ""}
								{isAccountSearchEngine(id) && status.accounts[id] ? ` · ${t("webTools.signedIn")}` : ""}
							</SelectItem>
						))}
					</SelectPopup>
				</Select>
				<p className="text-[length:var(--app-font-size-ui-xs,10px)] leading-relaxed text-muted-foreground">
					{t(providerHint(provider))}
				</p>
			</div>

			{keyed ? (
				<div className="flex flex-col gap-1">
					<Label>{t("webTools.apiKey")}</Label>
					<Input
						className="font-mono"
						type="password"
						autoComplete="off"
						disabled={!status.canStoreKeys}
						placeholder={saved ? t("webTools.apiKeySaved") : t("webTools.apiKeyPlaceholder")}
						value={key}
						onChange={(event) => setKey(event.target.value)}
					/>
					{!status.canStoreKeys ? (
						<p className="text-[length:var(--app-font-size-ui-xs,10px)] text-[var(--warning)]">{t("webTools.keyring")}</p>
					) : saved ? (
						<div>
							<Button disabled={busy} onClick={() => onSave({ keys: { [keyed]: null } })} size="sm" variant="ghost">
								{t("webTools.removeKey")}
							</Button>
						</div>
					) : null}
				</div>
			) : null}

			{isAccountSearchEngine(provider) ? (
				<p
					className={cn(
						"text-[length:var(--app-font-size-ui-xs,10px)] leading-relaxed",
						status.accounts[provider] ? "text-muted-foreground" : "text-[var(--warning)]",
					)}
				>
					{t(status.accounts[provider] ? "webTools.accountReady" : "webTools.accountMissing")}
				</p>
			) : null}

			{provider === "searxng" ? (
				<div className="flex flex-col gap-1">
					<Label>{t("webTools.searxngUrl")}</Label>
					<Input
						className="font-mono"
						placeholder="https://searx.example.org"
						value={searxngUrl}
						onChange={(event) => setSearxngUrl(event.target.value)}
					/>
				</div>
			) : null}

			{provider !== "duckduckgo" ? (
				<p className="text-[length:var(--app-font-size-ui-xs,10px)] leading-relaxed text-muted-foreground">
					{t("webTools.fallback")}
				</p>
			) : null}

			{error ? <p className="text-[length:var(--app-font-size-ui-xs,10px)] text-destructive">{error}</p> : null}
		</SettingsDialog>
	);
}

/** Web access at a glance: whether the agent has it, and where its searches go. */
export function WebToolsSettings() {
	const { t } = useTranslation();
	const [status, setStatus] = useState<WebToolsStatus | null>(null);
	const [editing, setEditing] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		api.webToolsStatus().then(setStatus).catch((cause: unknown) => setError(errorMessage(cause)));
	}, []);

	const save = (patch: WebToolsUpdate, close = false) => {
		setBusy(true);
		setError(null);
		api
			.webToolsSave(patch)
			.then((next) => {
				setStatus(next);
				if (close) setEditing(false);
			})
			.catch((cause: unknown) => setError(errorMessage(cause)))
			.finally(() => setBusy(false));
	};

	const missing = status ? gap(status) : null;

	return (
		<section className="flex flex-col gap-4 text-[length:var(--app-font-size-ui,12px)]">
			<p className="leading-relaxed text-muted-foreground">{t("webTools.intro")}</p>

			<div className="divide-y divide-[color:var(--app-surface-divider)]">
				<SettingsRow label={t("webTools.enabled")} hint={t("webTools.enabledHint")}>
					<Switch
						checked={status?.enabled ?? false}
						disabled={!status || busy}
						onCheckedChange={(checked: boolean) => save({ enabled: checked })}
					/>
				</SettingsRow>
			</div>

			<div
				className={cn(
					"flex items-center justify-between gap-4 rounded-xl border border-[color:var(--app-surface-divider)] p-4",
					status && !status.enabled && "opacity-60",
				)}
			>
				<div className="min-w-0">
					<div className="flex items-center gap-2">
						<span
							aria-hidden="true"
							className={cn(
								"size-2 shrink-0 rounded-full",
								!status?.enabled ? "bg-muted-foreground/40" : missing ? "bg-[var(--warning,#d97706)]" : "bg-[var(--success,#16a34a)]",
							)}
						/>
						{t("webTools.search")}
						{status ? (
							<span className="truncate font-mono text-xs text-muted-foreground">
								{t(providerLabel(status.provider))}
								{status.provider === "searxng" && status.searxngUrl ? ` · ${status.searxngUrl}` : ""}
								{isKeyedSearchEngine(status.provider) && status.keys[status.provider] ? ` · ${t("webTools.keySaved")}` : ""}
							</span>
						) : null}
					</div>
					<p className={cn("mt-1 text-xs", missing ? "text-[var(--warning,#d97706)]" : "text-muted-foreground")}>
						{status
							? missing
								? t(missing)
								: status.provider === "duckduckgo"
									? t("webTools.keyless")
									: t("webTools.fallback")
							: null}
					</p>
				</div>
				<Button disabled={!status} onClick={() => setEditing(true)} size="sm" variant="chrome-outline">
					<CustomizeIcon className="size-3.5" />
					{t("webTools.configure")}
				</Button>
			</div>

			<p className="text-xs leading-relaxed text-muted-foreground">{t("webTools.fetchNote")}</p>

			{error && !editing ? (
				<p role="alert" className="rounded-lg bg-destructive/10 p-3 text-destructive">
					{error}
				</p>
			) : null}

			{editing && status ? (
				<WebSearchDialog
					status={status}
					busy={busy}
					error={error}
					onClose={() => {
						setEditing(false);
						setError(null);
					}}
					onSave={(patch) => save(patch, patch.provider !== undefined)}
				/>
			) : null}
		</section>
	);
}
