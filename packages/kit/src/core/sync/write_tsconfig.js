import fs from 'fs';
import path from 'path';
import colors from 'kleur';
import { posixify } from '../../utils/filesystem.js';
import { write_if_changed } from './utils.js';

/**
 * @param {string} cwd
 * @param {string} file
 */
function maybe_file(cwd, file) {
	const resolved = path.resolve(cwd, file);
	if (fs.existsSync(resolved)) {
		return resolved;
	}
}

/**
 * @param {string} file
 */
function project_relative(file) {
	return posixify(path.relative('.', file));
}

/**
 * @param {string} file
 */
function remove_trailing_slashstar(file) {
	if (file.endsWith('/*')) {
		return file.slice(0, -2);
	} else {
		return file;
	}
}

/**
 * Writes the tsconfig that the user's tsconfig inherits from.
 * @param {import('types').ValidatedKitConfig} config
 */
export function write_tsconfig(config, cwd = process.cwd()) {
	const out = path.join(config.outDir, 'tsconfig.json');
	const user_file = maybe_file(cwd, 'tsconfig.json') || maybe_file(cwd, 'jsconfig.json');

	if (user_file) validate(config, cwd, out, user_file);

	/** @param {string} file */
	const config_relative = (file) => posixify(path.relative(config.outDir, file));

	const include = ['ambient.d.ts', './types/**/$types.d.ts', config_relative('vite.config.ts')];
	for (const dir of [config.files.routes, config.files.lib]) {
		const relative = project_relative(path.dirname(dir));
		include.push(config_relative(`${relative}/**/*.js`));
		include.push(config_relative(`${relative}/**/*.ts`));
		include.push(config_relative(`${relative}/**/*.svelte`));
	}
	// Test folder is a special case - we advocate putting tests in a top-level test folder
	// and it's not configurable (should we make it?)
	const test_folder = project_relative('tests');
	include.push(config_relative(`${test_folder}/**/*.js`));
	include.push(config_relative(`${test_folder}/**/*.ts`));
	include.push(config_relative(`${test_folder}/**/*.svelte`));

	const exclude = [config_relative('node_modules/**'), './[!ambient.d.ts]**'];
	if (path.extname(config.files.serviceWorker)) {
		exclude.push(config_relative(config.files.serviceWorker));
	} else {
		exclude.push(config_relative(`${config.files.serviceWorker}.js`));
		exclude.push(config_relative(`${config.files.serviceWorker}.ts`));
		exclude.push(config_relative(`${config.files.serviceWorker}.d.ts`));
	}

	write_if_changed(
		out,
		JSON.stringify(
			{
				compilerOptions: {
					// generated options
					baseUrl: config_relative('.'),
					paths: get_tsconfig_paths(config),
					rootDirs: [config_relative('.'), './types'],

					// essential options
					// svelte-preprocess cannot figure out whether you have a value or a type, so tell TypeScript
					// to enforce using \`import type\` instead of \`import\` for Types.
					importsNotUsedAsValues: 'error',
					// Vite compiles modules one at a time
					isolatedModules: true,
					// TypeScript doesn't know about import usages in the template because it only sees the
					// script of a Svelte file. Therefore preserve all value imports. Requires TS 4.5 or higher.
					preserveValueImports: true,

					// This is required for svelte-package to work as expected
					// Can be overwritten
					lib: ['esnext', 'DOM', 'DOM.Iterable'],
					moduleResolution: 'node',
					module: 'esnext',
					target: 'esnext'
				},
				include,
				exclude
			},
			null,
			'\t'
		)
	);
}

/**
 * @param {import('types').ValidatedKitConfig} config
 * @param {string} cwd
 * @param {string} out
 * @param {string} user_file
 */
function validate(config, cwd, out, user_file) {
	// we have to eval the file, since it's not parseable as JSON (contains comments)
	const user_tsconfig_json = fs.readFileSync(user_file, 'utf-8');
	const user_tsconfig = (0, eval)(`(${user_tsconfig_json})`);

	// we need to check that the user's tsconfig extends the framework config
	const extend = user_tsconfig.extends;
	const extends_framework_config = extend && path.resolve(cwd, extend) === out;

	const kind = path.basename(user_file);

	if (extends_framework_config) {
		const { paths: user_paths } = user_tsconfig.compilerOptions || {};

		if (user_paths && fs.existsSync(config.files.lib)) {
			/** @type {string[]} */
			const lib = user_paths['$lib'] || [];
			/** @type {string[]} */
			const lib_ = user_paths['$lib/*'] || [];

			const missing_lib_paths =
				!lib.some((relative) => path.resolve(cwd, relative) === config.files.lib) ||
				!lib_.some((relative) => path.resolve(cwd, relative) === path.join(config.files.lib, '/*'));

			if (missing_lib_paths) {
				console.warn(
					colors
						.bold()
						.yellow(`Your compilerOptions.paths in ${kind} should include the following:`)
				);
				const relative = posixify(path.relative('.', config.files.lib));
				console.warn(`{\n  "$lib":["${relative}"],\n  "$lib/*":["${relative}/*"]\n}`);
			}
		}
	} else {
		let relative = posixify(path.relative('.', out));
		if (!relative.startsWith('./')) relative = './' + relative;

		console.warn(
			colors.bold().yellow(`Your ${kind} should extend the configuration generated by SvelteKit:`)
		);
		console.warn(`{\n  "extends": "${relative}"\n}`);
	}
}

// <something><optional /*>
const alias_regex = /^(.+?)(\/\*)?$/;
// <path><optional /* or .fileending>
const value_regex = /^(.*?)((\/\*)|(\.\w+))?$/;

/**
 * Generates tsconfig path aliases from kit's aliases.
 * Related to vite alias creation.
 *
 * @param {import('types').ValidatedKitConfig} config
 */
export function get_tsconfig_paths(config) {
	const alias = {
		...config.alias
	};
	if (fs.existsSync(project_relative(config.files.lib))) {
		alias['$lib'] = project_relative(config.files.lib);
	}

	/** @type {Record<string, string[]>} */
	const paths = {};

	for (const [key, value] of Object.entries(alias)) {
		const key_match = alias_regex.exec(key);
		if (!key_match) throw new Error(`Invalid alias key: ${key}`);

		const value_match = value_regex.exec(value);
		if (!value_match) throw new Error(`Invalid alias value: ${value}`);

		const rel_path = project_relative(remove_trailing_slashstar(value));
		const slashstar = key_match[2];

		if (slashstar) {
			paths[key] = [rel_path + '/*'];
		} else {
			paths[key] = [rel_path];
			const fileending = value_match[4];

			if (!fileending && !(key + '/*' in alias)) {
				paths[key + '/*'] = [rel_path + '/*'];
			}
		}
	}

	return paths;
}
