import { Children, isValidElement, useEffect, useState, type ReactNode } from "react";
import { api } from "../../api";
import { useTranslation } from "../../i18n";
import { GlobeIcon } from "../../lib/icons";
import { cn } from "../../lib/utils";
import {
	extractCitations,
	hostOf,
	isCitationLabel,
	isWebUrl,
	useOpenLink,
	useWebTitle,
} from "../../lib/webSources";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** By origin, for the life of the window: a site's icon does not change mid-session. */
const icons = new Map<string, Promise<string | null>>();

function iconFor(url: string): Promise<string | null> {
	let origin: string;
	try {
		origin = new URL(url).origin;
	} catch {
		return Promise.resolve(null);
	}
	let pending = icons.get(origin);
	if (!pending) {
		pending = api.webFavicon(url).catch(() => null);
		icons.set(origin, pending);
	}
	return pending;
}

/** The site's icon, or a globe while it loads and when it has none. */
export function SiteIcon({ url, className }: { url: string; className?: string }) {
	const [src, setSrc] = useState<string | null>(null);
	useEffect(() => {
		let live = true;
		setSrc(null);
		void iconFor(url).then((data) => {
			if (live) setSrc(data);
		});
		return () => {
			live = false;
		};
	}, [url]);
	return src ? (
		<img alt="" src={src} className={cn("size-3.5 shrink-0 rounded-sm object-contain", className)} onError={() => setSrc(null)} />
	) : (
		<GlobeIcon className={cn("size-3.5 shrink-0 text-muted-foreground", className)} />
	);
}

function plainText(children: ReactNode): string {
	return Children.toArray(children)
		.map((child) =>
			typeof child === "string" || typeof child === "number"
				? String(child)
				: isValidElement<{ children?: ReactNode }>(child)
					? plainText(child.props.children)
					: "",
		)
		.join("");
}

/** Title over URL: what the hover says about a source. */
function SourceTooltip({ url, title }: { url: string; title?: string }) {
	return (
		<TooltipPopup className="max-w-[28rem]">
			<div className="flex flex-col gap-0.5">
				{title ? <span className="font-medium">{title}</span> : null}
				<span className="break-all font-mono text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">{url}</span>
			</div>
		</TooltipPopup>
	);
}

function CitationBadge({ label, url }: { label: string; url: string }) {
	const open = useOpenLink();
	const title = useWebTitle(url);
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						type="button"
						onClick={() => open(url)}
						className="citation-badge"
						aria-label={title ? `${label}: ${title}` : `${label}: ${url}`}
					/>
				}
			>
				{label}
			</TooltipTrigger>
			<SourceTooltip url={url} title={title} />
		</Tooltip>
	);
}

/** A link written as its own URL, shown as the page it points to. */
function UrlChip({ url }: { url: string }) {
	const open = useOpenLink();
	const title = useWebTitle(url);
	return (
		<Tooltip>
			<TooltipTrigger
				render={<button type="button" onClick={() => open(url)} className="source-chip" />}
			>
				<SiteIcon url={url} className="size-3" />
				<span className="truncate">{title ?? hostOf(url)}</span>
			</TooltipTrigger>
			<SourceTooltip url={url} title={title} />
		</Tooltip>
	);
}

/**
 * Every link in an answer.
 *
 * Opens through {@link useOpenLink} — never by navigating, which would take
 * the app window with it. A numbered link is a citation and renders as a
 * superscript; a bare URL renders as the page's icon and title; anything else
 * stays a text link whose address shows on hover.
 */
export function MarkdownLink({ href, children }: { href?: string; children?: ReactNode }) {
	const open = useOpenLink();
	if (!isWebUrl(href)) {
		// Relative paths and other schemes have nowhere sensible to go from here.
		return <span title={href}>{children}</span>;
	}
	const text = plainText(children).trim();
	if (isCitationLabel(text)) return <CitationBadge label={text} url={href} />;
	if (text === href || text === href.replace(/^https?:\/\//i, "")) return <UrlChip url={href} />;
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<a
						href={href}
						onClick={(event) => {
							event.preventDefault();
							open(href);
						}}
					/>
				}
			>
				{children}
			</TooltipTrigger>
			<SourceTooltip url={href} />
		</Tooltip>
	);
}

function SourceRow({ label, url }: { label: string; url: string }) {
	const open = useOpenLink();
	const title = useWebTitle(url);
	return (
		<li>
			<Tooltip>
				<TooltipTrigger
					render={
						<button
							type="button"
							onClick={() => open(url)}
							className="group flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-[var(--color-background-button-secondary-hover)]"
						/>
					}
				>
					<span className="citation-badge citation-badge--static">{label}</span>
					<SiteIcon url={url} />
					<span className="min-w-0 flex-1 truncate text-[length:var(--app-font-size-chat,12px)]">{title ?? hostOf(url)}</span>
					<span className="shrink-0 text-[length:var(--app-font-size-chat-meta,10px)] text-muted-foreground">{hostOf(url)}</span>
				</TooltipTrigger>
				<SourceTooltip url={url} title={title} />
			</Tooltip>
		</li>
	);
}

/** The pages an answer cites, listed under it by the UI rather than written by the model. */
export function SourceList({ text }: { text: string }) {
	const { t } = useTranslation();
	const citations = extractCitations(text);
	if (citations.length === 0) return null;
	return (
		<div className="flex flex-col gap-1 border-t border-[color:var(--app-surface-divider)] pt-2">
			<span className="px-1.5 text-[length:var(--app-font-size-chat-meta,10px)] font-medium text-muted-foreground">
				{t("chat.sources")}
			</span>
			<ol className="flex flex-col">
				{citations.map((citation) => (
					<SourceRow key={citation.url} label={citation.label} url={citation.url} />
				))}
			</ol>
		</div>
	);
}
