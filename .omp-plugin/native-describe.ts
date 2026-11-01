/**
 * Tern Surface Protocol (TSP) presentation for compacted components.
 *
 * Inside a TSP terminal (Tern) the host stops painting rows. Every transcript
 * block hands the terminal a semantic node through `describe(cx)`, and only
 * a component without one, or whose `describe` returns nothing, is painted
 * through `render(cx.cols)` as a `rows` node, which Tern badges as a
 * fallback. A `render` patch alone therefore leaves every stock card native
 * there. Each component the plugin presents compactly also answers
 * `describe`: its compact rows as one unwrapped `text` node, an invisible
 * node when it presents nothing, and the stock description whenever it stays
 * native.
 *
 * The compact rows are ANSI-styled; the host's own `rowsText` (the helper
 * stock components use for pre-rendered rows) maps their colours back to
 * theme tokens. It ships with the protocol (18.4.4), so it is imported
 * dynamically: an older host loads this module unchanged and never calls
 * `describe`.
 */

import { Container } from "@oh-my-pi/pi-tui";

import { objectRecord } from "./object-record";
import { resolveInstanceMethod } from "./presentation-patches";

type Lines = readonly string[];

// Dynamic: `native/spans` does not exist on hosts before 18.4.4, where a
// static import would fail the whole plugin's load.
const rowsText = await import("@oh-my-pi/pi-tui/native/spans").then(
	(spans): ((lines: Lines) => object) | undefined => spans.rowsText,
	() => undefined,
);

/**
 * The few fixed colours the plugin paints (`fixedForeground` in render.ts)
 * are no theme colour, so `rowsText` cannot map them back and would drop
 * them. Their basic SGR equivalents map to the semantic tokens that keep
 * their meaning: green additions, resolve and stats ink (`success`), rust
 * removals and reject (`error`), purple computer use (`accent`).
 */
const FIXED_COLOR_SGR = (
	[
		["#A4D734", 32],
		["#A1471A", 31],
		["#8D2A88", 35],
	] as const
).flatMap(([hex, sgr]) => {
	const truecolor = Bun.color(hex, "ansi-16m");
	return truecolor ? [[truecolor, `\x1b[${sgr}m`] as const] : [];
});

function themedLines(lines: Lines): Lines {
	return lines.map((line) => {
		let themed = line;
		for (const [truecolor, basic] of FIXED_COLOR_SGR)
			themed = themed.replaceAll(truecolor, basic);
		return themed;
	});
}

/** The host's `describe`, taken off the prototype chain before patching. */
export type NativeDescribe = (this: object, cx?: unknown) => unknown;

/**
 * The description the reconciler would ask `component` for, or `undefined`
 * where it paints rows instead. Mirrors its rule (`reconcile.ts`
 * `#resolve`): a `Container` subclass that paints its own rows but inherits
 * the plain column description has none. Read before patching, while the
 * instance's own `render` and `describe` are still the host's.
 */
export function stockDescribe(component: object): NativeDescribe | undefined {
	const describe = resolveInstanceMethod(component, "describe");
	if (
		describe === Container.prototype.describe &&
		resolveInstanceMethod(component, "render") !== Container.prototype.render
	)
		return undefined;
	return describe as NativeDescribe | undefined;
}

/** Stock `EMPTY_NODE`: mounted, never laid out, so it takes no room. */
export const HIDDEN_NODE: object = Object.freeze({
	k: "col",
	p: Object.freeze({ hidden: true }),
});

/**
 * Whether a stock description draws nothing: absent, hidden, or an empty
 * container (a tool-only assistant turn describes as a childless `col`).
 */
export function describesNothing(described: unknown): boolean {
	const node = objectRecord(described);
	if (typeof node.k !== "string") return true;
	if (objectRecord(node.p).hidden === true) return true;
	return (
		(node.k === "col" || node.k === "row") &&
		!(Array.isArray(node.c) && node.c.length > 0)
	);
}

/**
 * The surface width a describe context reports. The reconciler paints its
 * own `rows` fallback at `max(1, cx.cols)`; a context without a usable width
 * falls back to the process terminal.
 */
export function describeWidth(cx: unknown): number {
	const cols = objectRecord(cx).cols;
	if (typeof cols === "number" && Number.isFinite(cols) && cols >= 1)
		return Math.trunc(cols);
	return terminalColumns();
}

/** The process terminal's width, or 80 when stdout is not a terminal. */
export function terminalColumns(): number {
	const columns = process.stdout.columns;
	return typeof columns === "number" && columns > 0 ? columns : 80;
}

function sameLines(left: Lines, right: Lines): boolean {
	// Renderers return a fresh array per call; one mutated in place would
	// compare equal to itself here and keep its stale node.
	if (left === right) return true;
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index++)
		if (left[index] !== right[index]) return false;
	return true;
}

/**
 * One node per component, reused while its lines are unchanged. The
 * reconciler skips a component whose description is the object it returned
 * last frame, so an unchanged compact row costs no diff and no wire traffic.
 */
export class RowsNodes {
	#nodes = new WeakMap<object, { cols: number; lines: Lines; node: object }>();

	node(owner: object, lines: Lines, cols: number): object {
		if (lines.length === 0) return HIDDEN_NODE;
		const cached = this.#nodes.get(owner);
		if (cached && cached.cols === cols && sameLines(cached.lines, lines))
			return cached.node;
		const node = rowsText?.(themedLines(lines)) ?? {
			k: "rows",
			p: { cols, lines },
		};
		this.#nodes.set(owner, { cols, lines, node });
		return node;
	}
}

/**
 * `describe` wrapper for a leaf the plugin decides per paint, like its
 * `render` wrapper: `compactRows` answers the compact rows, or `undefined`
 * to keep the stock description. `undefined` when the leaf has no stock
 * description: the reconciler then paints the patched `render`, which
 * already answers compactly.
 */
export function compactDescribe(
	component: object,
	compactRows: (block: object, width: number) => Lines | undefined,
	nodes: RowsNodes,
): PropertyDescriptor | undefined {
	const native = stockDescribe(component);
	if (!native) return undefined;
	return {
		configurable: true,
		writable: true,
		value(this: object, cx?: unknown): unknown {
			const width = describeWidth(cx);
			const rows = compactRows(this, width);
			if (rows === undefined) return native.call(this, cx);
			return nodes.node(this, rows, width);
		},
	};
}
