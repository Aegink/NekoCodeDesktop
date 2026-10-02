import { useMemo, useState } from "react";
import { useTheme } from "../../hooks/useTheme";
import { useAppearancePreferences } from "../../hooks/useAppearancePreferences";
import { useTranslation, type TranslationKey } from "../../i18n";
import { getAvailableCodeThemes, type ThemeMode, type ThemeVariant } from "../../theme/theme.logic";
import { WINDOW_MATERIALS, type WindowMaterial } from "../../../../shared/window";
import { UI_DENSITY_MODES, type UiDensity } from "../../lib/appDensity";
import { CHAT_WIDTH_MODES, type ChatWidthMode } from "../../lib/chatWidth";
import { getAppTypographyScale } from "../../lib/appTypography";
import {
	DEFAULT_APPEARANCE_PREFERENCES,
	FONT_SIZE_RANGE,
	MONO_FONT_SIZE_RANGE,
} from "../../lib/appearancePreferences";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { Menu, MenuGroupLabel, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { ComposerPickerMenuPopup } from "../chat/ComposerPickerMenuPopup";
import { COMPOSER_PICKER_MENU_OPTION_CLASS_NAME, COMPOSER_TOOLBAR_PICKER_TRIGGER_CLASS_NAME } from "../chat/composerPickerStyles";
import { CheckIcon, ChevronDownIcon, MinusIcon, PlusIcon, RotateCcwIcon, XIcon } from "../../lib/icons";
import { FontFamilyPicker } from "./FontFamilyPicker";
import { SettingsRow } from "./SettingsRow";

const MODES: { id: ThemeMode; labelKey: TranslationKey }[] = [
	{ id: "light", labelKey: "theme.light" },
	{ id: "dark", labelKey: "theme.dark" },
	{ id: "system", labelKey: "theme.system" },
];

const MATERIAL_LABEL_KEYS: Record<WindowMaterial, TranslationKey> = {
	opaque: "settings.windowMaterial.opaque",
	mica: "settings.windowMaterial.mica",
	acrylic: "settings.windowMaterial.acrylic",
};

const DENSITY_LABEL_KEYS: Record<UiDensity, TranslationKey> = {
	compact: "settings.density.compact",
	comfortable: "settings.density.comfortable",
	spacious: "settings.density.spacious",
};

const CHAT_WIDTH_LABEL_KEYS: Record<ChatWidthMode, TranslationKey> = {
	standard: "settings.chatWidth.standard",
	wide: "settings.chatWidth.wide",
	full: "settings.chatWidth.full",
};

const ACCENT_PRESETS = ["#339cff", "#6e56cf", "#d6409f", "#e5484d", "#f76b15", "#ffb224", "#30a46c", "#12a594"];

const PREVIEW_TEXT = "The quick brown fox 敏捷的狐狸 0O 1lI => !=";

function SettingsGroup({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<section className="flex flex-col">
			<h3 className="pb-1 text-[length:var(--app-font-size-ui-xs,10px)] font-medium text-muted-foreground">
				{title}
			</h3>
			<div className="flex flex-col divide-y divide-[color:var(--app-surface-divider)]">{children}</div>
		</section>
	);
}

function SegmentedControl<T extends string>({
	value,
	options,
	onChange,
}: {
	value: T;
	options: readonly { id: T; label: string }[];
	onChange: (value: T) => void;
}) {
	return (
		<div className="flex items-center gap-1 rounded-lg bg-[var(--color-background-elevated-secondary)] p-0.5">
			{options.map((entry) => (
				<button
					key={entry.id}
					type="button"
					onClick={() => onChange(entry.id)}
					className={cn(
						"rounded-md px-2.5 py-1 text-[length:var(--app-font-size-ui-sm,11px)] transition-colors",
						value === entry.id
							? "bg-[var(--composer-surface)] text-[var(--color-text-foreground)] shadow-sm"
							: "text-muted-foreground hover:text-foreground",
					)}
				>
					{entry.label}
				</button>
			))}
		</div>
	);
}

/** − 13px + with a reset arrow once the value leaves its default. */
function SizeStepper({
	value,
	min,
	max,
	onChange,
	onReset,
	label,
}: {
	value: number;
	min: number;
	max: number;
	onChange: (value: number) => void;
	/** Shown only when set — i.e. when the value differs from its default. */
	onReset?: () => void;
	label?: string;
}) {
	const { t } = useTranslation();
	return (
		<div className="flex items-center gap-1">
			{/* Always laid out, so the steppers line up whether or not a row is at its default. */}
			<Button
				aria-hidden={!onReset}
				aria-label={t("common.reset")}
				className={cn(!onReset && "invisible")}
				onClick={onReset}
				size="icon-chip"
				title={t("common.reset")}
				variant="ghost"
			>
				<RotateCcwIcon />
			</Button>
			<Button aria-label="-" disabled={value <= min} onClick={() => onChange(value - 1)} size="icon-chip" variant="ghost">
				<MinusIcon />
			</Button>
			<span className="min-w-14 text-center text-[length:var(--app-font-size-ui-sm,11px)] tabular-nums">
				{label ?? `${value}px`}
			</span>
			<Button aria-label="+" disabled={value >= max} onClick={() => onChange(value + 1)} size="icon-chip" variant="ghost">
				<PlusIcon />
			</Button>
		</div>
	);
}

function ClearFontButton({ visible, onClear }: { visible: boolean; onClear: () => void }) {
	const { t } = useTranslation();
	return (
		<Button
			aria-hidden={!visible}
			aria-label={t("common.clear")}
			className={cn(!visible && "invisible")}
			onClick={onClear}
			size="icon-chip"
			title={t("common.clear")}
			variant="ghost"
		>
			<XIcon />
		</Button>
	);
}

function AccentPicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
	const { t } = useTranslation();
	const isPreset = ACCENT_PRESETS.includes(value);
	return (
		<div className="flex items-center gap-1.5">
			{ACCENT_PRESETS.map((color) => (
				<button
					key={color}
					aria-label={color}
					className="flex size-5 items-center justify-center rounded-full ring-offset-2 ring-offset-[var(--app-settings-surface)] transition-transform hover:scale-110 data-[active=true]:ring-2 data-[active=true]:ring-[color:var(--color-border-heavy)]"
					data-active={value === color}
					onClick={() => onChange(color)}
					style={{ backgroundColor: color }}
					type="button"
				>
					{value === color ? <CheckIcon className="size-3 text-white" /> : null}
				</button>
			))}
			<label
				className={cn(
					"relative size-5 cursor-pointer overflow-hidden rounded-full ring-offset-2 ring-offset-[var(--app-settings-surface)]",
					!isPreset && "ring-2 ring-[color:var(--color-border-heavy)]",
				)}
				style={{
					background: isPreset
						? "conic-gradient(#e5484d, #ffb224, #30a46c, #12a594, #339cff, #6e56cf, #d6409f, #e5484d)"
						: value,
				}}
				title={t("settings.accentColorCustom")}
			>
				<input
					aria-label={t("settings.accentColorCustom")}
					className="absolute inset-0 cursor-pointer opacity-0"
					onChange={(event) => onChange(event.currentTarget.value)}
					type="color"
					value={value}
				/>
			</label>
		</div>
	);
}

export function AppearanceSettings() {
	const { t } = useTranslation();
	const {
		theme,
		activeTheme,
		resolvedTheme,
		setTheme,
		themeState,
		setCodeThemeId,
		systemUiFont,
		setSystemUiFont,
		windowMaterial,
		setWindowMaterial,
		supportedWindowMaterials,
		updateThemePack,
		resetAllThemes,
	} = useTheme();
	const { preferences, updatePreferences, resetPreferences } = useAppearancePreferences();
	const codeThemes = useMemo(() => getAvailableCodeThemes(resolvedTheme), [resolvedTheme]);
	const activeCodeThemeId = themeState.codeThemeIds[resolvedTheme as ThemeVariant];
	const [menuOpen, setMenuOpen] = useState(false);
	const [materialMenuOpen, setMaterialMenuOpen] = useState(false);
	// Windows before 11 22H2 (and every other platform) can only paint the opaque
	// shell; the rest stay listed but unpickable, so the setting explains itself
	// instead of silently vanishing.
	const hasBackdrops = supportedWindowMaterials.length > 1;
	const variantLabel = t(resolvedTheme === "dark" ? "theme.dark" : "theme.light");
	const scaledCodePx = getAppTypographyScale(preferences.fontSizePx).chatCodePx;
	const defaults = DEFAULT_APPEARANCE_PREFERENCES;

	return (
		<div className="flex flex-col gap-6">
			<SettingsGroup title={t("settings.appearance.group.theme")}>
				<SettingsRow hint={t("settings.themeModeHint")} label={t("settings.themeMode")}>
					<SegmentedControl
						onChange={setTheme}
						options={MODES.map((entry) => ({ id: entry.id, label: t(entry.labelKey) }))}
						value={theme}
					/>
				</SettingsRow>

				<SettingsRow hint={t("settings.codeThemeHint", { variant: variantLabel })} label={t("settings.codeTheme")}>
					<Menu open={menuOpen} onOpenChange={setMenuOpen}>
						<MenuTrigger
							render={
								<Button
									className={cn(COMPOSER_TOOLBAR_PICKER_TRIGGER_CLASS_NAME, "border-transparent")}
									size="chip"
									variant="ghost"
								>
									<span className="truncate">
										{codeThemes.find((option) => option.id === activeCodeThemeId)?.label ??
											activeCodeThemeId}
									</span>
									<ChevronDownIcon className="size-3 opacity-60" />
								</Button>
							}
						/>
						<ComposerPickerMenuPopup align="end" side="bottom">
							{/* Inside the radio group, not beside it: Base UI takes the group
							    context from MenuRadioGroup, and a label outside one throws as
							    soon as the menu opens. */}
							<MenuRadioGroup
								value={activeCodeThemeId}
								onValueChange={(value) => {
									setCodeThemeId(resolvedTheme as ThemeVariant, value);
									setMenuOpen(false);
								}}
							>
								<MenuGroupLabel>{t("settings.codeTheme")}</MenuGroupLabel>
								{codeThemes.map((option) => (
									<MenuRadioItem
										key={option.id}
										className={COMPOSER_PICKER_MENU_OPTION_CLASS_NAME}
										value={option.id}
									>
										{option.label}
									</MenuRadioItem>
								))}
							</MenuRadioGroup>
						</ComposerPickerMenuPopup>
					</Menu>
				</SettingsRow>

				<SettingsRow hint={t("settings.accentColorHint", { variant: variantLabel })} label={t("settings.accentColor")}>
					<AccentPicker
						onChange={(accent) => updateThemePack(resolvedTheme, { accent })}
						value={activeTheme.theme.accent}
					/>
				</SettingsRow>

				<SettingsRow hint={t("settings.contrastHint", { variant: variantLabel })} label={t("settings.contrast")}>
					<div className="flex items-center gap-2">
						<input
							aria-label={t("settings.contrast")}
							className="theme-slider h-1 w-36 cursor-pointer appearance-none rounded-full bg-[color-mix(in_srgb,var(--color-text-foreground)_14%,transparent)]"
							max={100}
							min={0}
							onChange={(event) => updateThemePack(resolvedTheme, { contrast: Number(event.currentTarget.value) })}
							step={1}
							type="range"
							value={activeTheme.theme.contrast}
						/>
						<span className="w-7 text-right text-[length:var(--app-font-size-ui-sm,11px)] tabular-nums text-muted-foreground">
							{activeTheme.theme.contrast}
						</span>
					</div>
				</SettingsRow>

				<SettingsRow
					hint={
						hasBackdrops ? t("settings.windowMaterialHint") : t("settings.windowMaterialUnsupported")
					}
					label={t("settings.windowMaterial")}
				>
					<Menu open={materialMenuOpen} onOpenChange={setMaterialMenuOpen}>
						<MenuTrigger
							render={
								<Button
									className={cn(COMPOSER_TOOLBAR_PICKER_TRIGGER_CLASS_NAME, "border-transparent")}
									size="chip"
									variant="ghost"
								>
									<span className="truncate">{t(MATERIAL_LABEL_KEYS[windowMaterial])}</span>
									<ChevronDownIcon className="size-3 opacity-60" />
								</Button>
							}
						/>
						<ComposerPickerMenuPopup align="end" side="bottom">
							<MenuRadioGroup
								value={windowMaterial}
								onValueChange={(value) => {
									void setWindowMaterial(value as WindowMaterial);
									setMaterialMenuOpen(false);
								}}
							>
								<MenuGroupLabel>{t("settings.windowMaterial")}</MenuGroupLabel>
								{WINDOW_MATERIALS.map((material) => (
									<MenuRadioItem
										key={material}
										className={COMPOSER_PICKER_MENU_OPTION_CLASS_NAME}
										disabled={!supportedWindowMaterials.includes(material)}
										value={material}
									>
										{t(MATERIAL_LABEL_KEYS[material])}
									</MenuRadioItem>
								))}
							</MenuRadioGroup>
						</ComposerPickerMenuPopup>
					</Menu>
				</SettingsRow>
			</SettingsGroup>

			<SettingsGroup title={t("settings.appearance.group.fonts")}>
				<SettingsRow hint={t("settings.uiFontHint")} label={t("settings.uiFont")}>
					<div className="flex items-center gap-1">
						<FontFamilyPicker
							onChange={(uiFontFamily) => updatePreferences({ uiFontFamily })}
							placeholder={t("settings.fontDefault")}
							value={preferences.uiFontFamily}
						/>
						<ClearFontButton onClear={() => updatePreferences({ uiFontFamily: null })} visible={preferences.uiFontFamily !== null} />
					</div>
				</SettingsRow>

				<SettingsRow hint={t("settings.systemUiFontHint")} label={t("settings.systemUiFont")}>
					<Switch
						checked={systemUiFont}
						disabled={preferences.uiFontFamily !== null}
						onCheckedChange={(checked) => setSystemUiFont(checked)}
					/>
				</SettingsRow>

				<SettingsRow hint={t("settings.codeFontHint")} label={t("settings.codeFont")}>
					<div className="flex items-center gap-1">
						<FontFamilyPicker
							monospace
							onChange={(codeFontFamily) => updatePreferences({ codeFontFamily })}
							placeholder={t("settings.fontDefault")}
							value={preferences.codeFontFamily}
						/>
						<ClearFontButton
							onClear={() => updatePreferences({ codeFontFamily: null })}
							visible={preferences.codeFontFamily !== null}
						/>
					</div>
				</SettingsRow>

				<SettingsRow hint={t("settings.fontSizeHint")} label={t("settings.fontSize")}>
					<SizeStepper
						max={FONT_SIZE_RANGE.max}
						min={FONT_SIZE_RANGE.min}
						onChange={(fontSizePx) => updatePreferences({ fontSizePx })}
						onReset={
							preferences.fontSizePx !== defaults.fontSizePx
								? () => updatePreferences({ fontSizePx: defaults.fontSizePx })
								: undefined
						}
						value={preferences.fontSizePx}
					/>
				</SettingsRow>

				<SettingsRow hint={t("settings.codeFontSizeHint")} label={t("settings.codeFontSize")}>
					<SizeStepper
						label={
							preferences.codeFontSizePx === null
								? `${t("settings.fontSizeAuto")} · ${scaledCodePx}px`
								: undefined
						}
						max={MONO_FONT_SIZE_RANGE.max}
						min={MONO_FONT_SIZE_RANGE.min}
						onChange={(codeFontSizePx) => updatePreferences({ codeFontSizePx })}
						onReset={
							preferences.codeFontSizePx !== null
								? () => updatePreferences({ codeFontSizePx: null })
								: undefined
						}
						value={preferences.codeFontSizePx ?? scaledCodePx}
					/>
				</SettingsRow>

				<SettingsRow hint={t("settings.terminalFontSizeHint")} label={t("settings.terminalFontSize")}>
					<SizeStepper
						max={MONO_FONT_SIZE_RANGE.max}
						min={MONO_FONT_SIZE_RANGE.min}
						onChange={(terminalFontSizePx) => updatePreferences({ terminalFontSizePx })}
						onReset={
							preferences.terminalFontSizePx !== defaults.terminalFontSizePx
								? () => updatePreferences({ terminalFontSizePx: defaults.terminalFontSizePx })
								: undefined
						}
						value={preferences.terminalFontSizePx}
					/>
				</SettingsRow>

				<SettingsRow hint={t("settings.editorFontSizeHint")} label={t("settings.editorFontSize")}>
					<SizeStepper
						max={MONO_FONT_SIZE_RANGE.max}
						min={MONO_FONT_SIZE_RANGE.min}
						onChange={(editorFontSizePx) => updatePreferences({ editorFontSizePx })}
						onReset={
							preferences.editorFontSizePx !== defaults.editorFontSizePx
								? () => updatePreferences({ editorFontSizePx: defaults.editorFontSizePx })
								: undefined
						}
						value={preferences.editorFontSizePx}
					/>
				</SettingsRow>

				<SettingsRow hint={t("settings.codeLigaturesHint")} label={t("settings.codeLigatures")}>
					<Switch
						checked={preferences.codeLigatures}
						onCheckedChange={(codeLigatures) => updatePreferences({ codeLigatures })}
					/>
				</SettingsRow>

				<div className="flex flex-col gap-1.5 py-2.5">
					<span className="text-[length:var(--app-font-size-ui,12px)]">{t("settings.fontPreview")}</span>
					<div className="flex flex-col gap-1 rounded-lg border border-[color:var(--color-border)] px-3 py-2">
						<span className="font-sans text-[length:var(--app-font-size-chat-body,13px)]">{PREVIEW_TEXT}</span>
						<code className="font-chat-code text-[length:var(--app-font-size-chat-code,11px)] text-muted-foreground">
							{"const neko = (paws) => paws !== 0 && paws <= 4; // 喵"}
						</code>
					</div>
				</div>
			</SettingsGroup>

			<SettingsGroup title={t("settings.appearance.group.layout")}>
				<SettingsRow hint={t("settings.densityHint")} label={t("settings.density")}>
					<SegmentedControl
						onChange={(density) => updatePreferences({ density })}
						options={UI_DENSITY_MODES.map((id) => ({ id, label: t(DENSITY_LABEL_KEYS[id]) }))}
						value={preferences.density}
					/>
				</SettingsRow>

				<SettingsRow hint={t("settings.chatWidthHint")} label={t("settings.chatWidth")}>
					<SegmentedControl
						onChange={(chatWidth) => updatePreferences({ chatWidth })}
						options={CHAT_WIDTH_MODES.map((id) => ({ id, label: t(CHAT_WIDTH_LABEL_KEYS[id]) }))}
						value={preferences.chatWidth}
					/>
				</SettingsRow>

				<SettingsRow hint={t("settings.resetAppearanceHint")} label={t("settings.resetAppearance")}>
					<Button
						onClick={() => {
							resetAllThemes();
							resetPreferences();
						}}
						size="sm"
						variant="chrome-outline"
					>
						{t("common.reset")}
					</Button>
				</SettingsRow>
			</SettingsGroup>
		</div>
	);
}
