export interface BittuneConfigureOptions {
	baseUrl?: string;
	modelId?: string;
	providerId?: string;
	apiKeyEnv?: string;
}

export interface BittuneInstallOptions {
	checkOnly: boolean;
	json: boolean;
	yes: boolean;
	user?: string;
	packagePath?: string;
	bundleDir?: string;
	/** Bootstrap-prepared agent staging directory; adopted instead of a fresh extract. */
	stageDir?: string;
	/** Pinned Python requirements list shipped beside the bootstrap entrypoint. */
	requirementsPath?: string;
	/** Directory holding the prebuilt bittune_core wheel shipped with the release. */
	coreWheelDir?: string;
}

export type CloudCliSubcommand =
	| { name: "configure"; profile?: string; profileFile?: string; devCa?: string }
	| { name: "connect"; profile?: string }
	| { name: "status" }
	| { name: "disconnect" }
	| { name: "mode"; value: "cloud_preferred" | "local_only" };

export type BittuneCliInvocation =
	| { kind: "help" }
	| { kind: "version" }
	| { kind: "doctor" }
	| { kind: "install"; options: BittuneInstallOptions }
	| { kind: "configure"; options: BittuneConfigureOptions }
	| { kind: "cloud"; subcommand: CloudCliSubcommand }
	| { kind: "reproduce"; file: string }
	| { kind: "interactive"; sessionId?: string; message?: string };

const CONFIGURE_OPTIONS: Readonly<Record<string, keyof BittuneConfigureOptions>> = {
	"--base-url": "baseUrl",
	"--model-id": "modelId",
	"--provider-id": "providerId",
	"--api-key-env": "apiKeyEnv",
};

function usageError(message: string): Error {
	return new Error(`${message} Run \`bittune --help\` for usage.`);
}

function parseOptions(args: string[], allowed: ReadonlySet<string>, command: string): Map<string, string> {
	const values = new Map<string, string>();
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index]!;
		if (!arg.startsWith("-")) throw usageError(`Unexpected argument \"${arg}\" for ${command}.`);
		if (!allowed.has(arg)) throw usageError(`Unknown option \"${arg}\" for ${command}.`);
		if (values.has(arg)) throw usageError(`Option \"${arg}\" may only be specified once.`);
		const value = args[index + 1];
		if (value === undefined || value.startsWith("-")) {
			throw usageError(`Option \"${arg}\" requires a value.`);
		}
		values.set(arg, value);
		index += 1;
	}
	return values;
}

function parseConfigure(args: string[]): BittuneCliInvocation {
	if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return { kind: "help" };
	const values = parseOptions(args, new Set(Object.keys(CONFIGURE_OPTIONS)), "bittune configure");
	const options: BittuneConfigureOptions = {};
	for (const [flag, key] of Object.entries(CONFIGURE_OPTIONS)) {
		const value = values.get(flag);
		if (value !== undefined) options[key] = value;
	}
	return { kind: "configure", options };
}

function parseInteractive(args: string[]): BittuneCliInvocation {
	const values = new Map<string, string>();
	const messages: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index]!;
		if (arg === "--session") {
			if (values.has(arg)) throw usageError("Option \"--session\" may only be specified once.");
			const value = args[index + 1];
			if (value === undefined || value.startsWith("-")) throw usageError("Option \"--session\" requires a value.");
			values.set(arg, value);
			index += 1;
			continue;
		}
		if (arg.startsWith("-")) throw usageError(`Unknown option \"${arg}\" for bittune.`);
		messages.push(arg);
	}
	const sessionId = values.get("--session");
	return {
		kind: "interactive",
		...(sessionId ? { sessionId } : {}),
		...(messages.length > 0 ? { message: messages.join(" ") } : {}),
	};
}

function parseReproduce(args: string[]): BittuneCliInvocation {
	if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return { kind: "help" };
	const values = parseOptions(args, new Set(["--file"]), "bittune reproduce");
	const file = values.get("--file");
	if (!file) throw usageError("bittune reproduce requires --file <path>.");
	return { kind: "reproduce", file };
}

function parseInstall(args: string[]): BittuneCliInvocation {
	if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return { kind: "help" };
	const options: BittuneInstallOptions = { checkOnly: false, json: false, yes: false };
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index]!;
		const value = () => {
			const next = args[index + 1];
			if (next === undefined || next.startsWith("-")) throw usageError(`Option \"${arg}\" requires a value.`);
			index += 1;
			return next;
		};
		switch (arg) {
			case "--check-only": options.checkOnly = true; break;
			case "--json": options.json = true; break;
			case "--yes": options.yes = true; break;
			case "--user": options.user = value(); break;
			case "--package": options.packagePath = value(); break;
			case "--offline": options.bundleDir = value(); break;
			case "--stage-dir": options.stageDir = value(); break;
			case "--requirements": options.requirementsPath = value(); break;
			case "--core-wheel-dir": options.coreWheelDir = value(); break;
			default: throw usageError(`Unknown option \"${arg}\" for bittune install.`);
		}
	}
	return { kind: "install", options };
}

const CLOUD_CONFIGURE_OPTIONS: Readonly<Record<string, "profile" | "profileFile" | "devCa">> = {
	"--profile": "profile",
	"--profile-file": "profileFile",
	"--dev-ca": "devCa",
};

function parseCloud(args: string[]): BittuneCliInvocation {
	const [subcommand, ...rest] = args;
	if (subcommand === undefined) throw usageError("Usage: bittune cloud <configure|connect|status|disconnect|mode>.");
	switch (subcommand) {
		case "configure": {
			const values = parseOptions(rest, new Set(Object.keys(CLOUD_CONFIGURE_OPTIONS)), "bittune cloud configure");
			const options: { profile?: string; profileFile?: string; devCa?: string } = {};
			for (const [flag, key] of Object.entries(CLOUD_CONFIGURE_OPTIONS)) {
				const value = values.get(flag);
				if (value !== undefined) options[key] = value;
			}
			if (!options.profile && !options.profileFile) {
				throw usageError("bittune cloud configure requires --profile or --profile-file.");
			}
			if (options.profile && options.profileFile) {
				throw usageError("--profile and --profile-file are mutually exclusive.");
			}
			return { kind: "cloud", subcommand: { name: "configure", ...options } };
		}
		case "connect": {
			const values = parseOptions(rest, new Set(["--profile"]), "bittune cloud connect");
			return { kind: "cloud", subcommand: { name: "connect", profile: values.get("--profile") } };
		}
		case "status":
			if (rest.length > 0) throw usageError("The cloud status command does not accept arguments.");
			return { kind: "cloud", subcommand: { name: "status" } };
		case "disconnect":
			if (rest.length > 0) throw usageError("The cloud disconnect command does not accept arguments.");
			return { kind: "cloud", subcommand: { name: "disconnect" } };
		case "mode": {
			if (rest.length !== 1) throw usageError(`Usage: bittune cloud mode <cloud_preferred|local_only>.`);
			const value = rest[0];
			if (value !== "cloud_preferred" && value !== "local_only") {
				throw usageError(`Unknown cloud mode \"${value}\".`);
			}
			return { kind: "cloud", subcommand: { name: "mode", value } };
		}
		default:
			throw usageError(`Unknown cloud command \"${subcommand}\".`);
	}
}

function parseBittuneCliArgumentsInner(command: string, rest: string[]): BittuneCliInvocation | undefined {
	if (command === "configure") return parseConfigure(rest);
	if (command === "install") return parseInstall(rest);
	if (command === "cloud") return parseCloud(rest);
	if (command === "reproduce") return parseReproduce(rest);
	return undefined;
}

export function parseBittuneCliArguments(argv: string[]): BittuneCliInvocation {
	const [command, ...args] = argv;
	if (command === undefined) return { kind: "interactive" };
	if (command === "--help" || command === "-h" || command === "help") {
		if (args.length > 0) throw usageError(`Unexpected argument \"${args[0]}\".`);
		return { kind: "help" };
	}
	if (command === "--version" || command === "-v" || command === "version") {
		if (args.length > 0) throw usageError(`Unexpected argument \"${args[0]}\" for version.`);
		return { kind: "version" };
	}
	const named = parseBittuneCliArgumentsInner(command, args);
	if (named) return named;
	if (command === "doctor") {
		if (args.length > 0) throw usageError("The doctor command does not accept arguments.");
		return { kind: "doctor" };
	}
	return parseInteractive(argv);
}
