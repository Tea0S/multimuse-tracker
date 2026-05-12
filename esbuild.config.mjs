import esbuild from "esbuild";
import process from "process";
import { builtinModules } from "module";

const isProduction = process.argv.includes("production");

const ctx = await esbuild.context({
	bundle: true,
	entryPoints: ["main.ts"],
	external: [
		"obsidian",
		"electron",
		"@codemirror/autocomplete",
		"@codemirror/collab",
		"@codemirror/commands",
		"@codemirror/language",
		"@codemirror/lint",
		"@codemirror/search",
		"@codemirror/state",
		"@codemirror/view",
		"@lezer/common",
		"@lezer/highlight",
		"@lezer/lr",
		...builtinModules],
	format: "cjs",
	target: "es2018",
	logLevel: "info",
	sourcemap: isProduction ? false : "inline",
	treeShaking: true,
	outfile: "main.js",
});

if (isProduction) {
	await ctx.rebuild();
	process.exit(0);
} else {
	await ctx.watch();
}

