import { useEffect } from "react";
import { useTheme } from "../hooks/useTheme";
import { useCommunityArt, useThemeLibrary } from "../hooks/useThemeLibrary";

/** How much of the artwork shows at full strength: behind an empty chat, and behind a conversation. */
const HOME_OPACITY = 0.6;
const CONVERSATION_OPACITY = 0.14;
/** How much of the window chrome's tint gives way to the blurred artwork at full strength. */
const CHROME_ART_SHARE = 40;

/** The community theme the visible variant uses, and its artwork once loaded. */
function useActiveArt() {
	const { communityThemeId, artStrength } = useTheme();
	const library = useThemeLibrary();
	const theme = communityThemeId ? library?.themes.find((entry) => entry.id === communityThemeId) : undefined;
	const art = useCommunityArt(theme);
	return { theme: theme && art ? theme : undefined, art, artStrength };
}

/**
 * A community theme's artwork behind the chat.
 *
 * Drawn at a negative z-index inside the chat card, which is its own stacking
 * context: above the card's background, below everything in it, so nothing
 * else has to change for it. The veil is the card's own surface color showing
 * through the image's opacity — strong on an empty chat, faint behind
 * conversation text. A `home`-scoped theme keeps its artwork to the empty chat.
 */
export function CommunityBackground({ empty }: { empty: boolean }) {
	const { theme, art, artStrength } = useActiveArt();
	if (!theme || !art) return null;
	if (theme.backgroundScope === "home" && !empty) return null;
	const opacity = ((empty ? HOME_OPACITY : CONVERSATION_OPACITY) * artStrength) / 100;
	return (
		<div
			aria-hidden="true"
			className="community-art pointer-events-none absolute inset-0 -z-10 bg-cover bg-no-repeat transition-opacity duration-300"
			style={{ backgroundImage: `url("${art}")`, backgroundPosition: theme.artPosition, opacity }}
		/>
	);
}

/**
 * The same artwork, heavily blurred, under the window chrome — title bar,
 * sidebar, and the strip around the cards.
 *
 * Without it the chrome shows the desktop through the window material, whose
 * color has nothing to do with the theme, and the sharp artwork in the chat
 * card ends at a hard edge against it. Under a community theme the chrome tint
 * becomes the theme's own surface color, thinned (see `index.css`) so this
 * wash of the artwork's colors comes through as frosted glass.
 */
export function CommunityAmbient() {
	const { theme, art, artStrength } = useActiveArt();
	const active = !!theme && !!art;
	useEffect(() => {
		const root = document.documentElement;
		if (!active) return;
		root.setAttribute("data-community-art", "");
		root.style.setProperty("--community-chrome-tint", `${100 - (CHROME_ART_SHARE * artStrength) / 100}%`);
		return () => {
			root.removeAttribute("data-community-art");
			root.style.removeProperty("--community-chrome-tint");
		};
	}, [active, artStrength]);
	if (!theme || !art) return null;
	return (
		<div
			aria-hidden="true"
			className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
		>
			<div
				className="absolute inset-0 scale-110 bg-cover bg-no-repeat blur-[36px] saturate-[1.15]"
				style={{ backgroundImage: `url("${art}")`, backgroundPosition: theme.artPosition }}
			/>
		</div>
	);
}
