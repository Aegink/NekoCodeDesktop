/**
 * Words for the lexical half of the index.
 *
 * Code names things in compounds — `parseSessionFile`, `MAX_FILE_BYTES`,
 * `session-title` — and a question names them in pieces ("where is the session
 * file parsed"). So identifiers are split at case and separator boundaries and
 * kept whole as well, and Han text, which has no spaces, is cut into
 * overlapping pairs of characters.
 */

/** Words too common in code and questions to say anything about either. */
const STOPWORDS = new Set([
	"a", "an", "and", "are", "as", "at", "be", "by", "do", "does", "for", "from", "how", "if", "in", "is", "it",
	"of", "on", "or", "the", "this", "to", "what", "when", "where", "which", "who", "why", "with",
	"const", "let", "var", "return", "import", "export", "function", "def", "class", "new", "true", "false",
	"null", "undefined", "void", "self", "public", "private", "static", "async", "await", "type", "interface",
]);

const WORD = /[A-Za-z_$][A-Za-z0-9_$]*|[0-9]+|\p{Script=Han}+/gu;
const HAN = /^\p{Script=Han}/u;

/** `parseHTTPResponse2` → `parse`, `http`, `response`, `2`. */
export function splitIdentifier(word: string): string[] {
	return word
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.replace(/([A-Za-z])([0-9])/g, "$1 $2")
		.split(/[\s_$]+/)
		.filter(Boolean)
		.map((part) => part.toLowerCase());
}

/** The crudest stemmer that still matches "sessions" to "session". */
function stem(word: string): string {
	if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
	if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") && !word.endsWith("us")) return word.slice(0, -1);
	return word;
}

/** Index terms for a piece of text, repeated as often as they occur. */
export function tokenize(text: string): string[] {
	const terms: string[] = [];
	for (const match of text.matchAll(WORD)) {
		const word = match[0];
		if (HAN.test(word)) {
			if (word.length === 1) terms.push(word);
			for (let i = 0; i + 1 < word.length; i++) terms.push(word.slice(i, i + 2));
			continue;
		}
		const parts = splitIdentifier(word);
		for (const part of parts) {
			if (part.length < 2 || STOPWORDS.has(part)) continue;
			terms.push(stem(part));
		}
		// The compound itself, so an exact name outranks its scattered parts.
		if (parts.length > 1) terms.push(word.toLowerCase());
	}
	return terms;
}

/** Term → occurrences, the form a chunk is indexed in. */
export function termFrequencies(terms: readonly string[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
	return counts;
}
