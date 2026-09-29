//! Port of `bin/dsh-deps.js` — DSH lane-plugin dependency resolution.
//!
//! Pure file/JSON operations (PLAN.md §3): PATH-shim discovery, the upward
//! realpath walk, `package.json` entry resolution and `file:` URL baking.
//! Nothing here executes Node or DSH. `test/dsh-deps.test.js` is the
//! behavioral spec; the unit tests below mirror its scenarios 1:1.
//!
//! Where the JS reads the environment (`PATH`,
//! `MY_WORKBENCH_DSH_NODE_MODULES`), the low-level functions take those
//! values as parameters and only the production entry points
//! ([`resolve_lane_dependencies`], used by the DSH install path) read
//! `std::env` directly, so tests never mutate global state.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use crate::error::WorkbenchError;

/// One resolved deployment package: the entry file, the node_modules root it
/// was found under, and the manifest version (`"unknown"` when absent).
pub struct PackageRef {
    pub file: PathBuf,
    pub root: PathBuf,
    pub version: String,
}

// --------------------------------------------------------------------- roots

/// Find dependency roots without starting a DSH process. Inputs describe a
/// (possibly temporary) install: the DSH home, the `PATH` string and the
/// explicit `MY_WORKBENCH_DSH_NODE_MODULES` override (`None` or an empty path
/// when unset — the JS treats an empty string as falsy).
///
/// Root order is load-bearing (the first root carrying a package wins):
/// `<home>/profiles/node_modules`, then per profile dir (sorted)
/// `<profile>/node_modules` + `<profile>/.dsh-module-fallback/node_modules`,
/// then the env-modules override, then the launcher roots.
pub fn dsh_module_roots(home: &Path, path_env: &str, env_modules: Option<&Path>) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    let profiles_dir = home.join("profiles");
    roots.push(profiles_dir.join("node_modules"));
    if profiles_dir.exists() {
        for name in sorted_readdir(&profiles_dir) {
            let dir = profiles_dir.join(&name);
            match std::fs::metadata(&dir) {
                Ok(meta) if meta.is_dir() => {}
                // Vanished between readdir and stat, or not a directory.
                _ => continue,
            }
            roots.push(dir.join("node_modules"));
            roots.push(dir.join(".dsh-module-fallback").join("node_modules"));
        }
    }
    if let Some(modules) = env_modules {
        if !modules.as_os_str().is_empty() {
            roots.push(modules.to_path_buf());
        }
    }
    roots.extend(dsh_launcher_module_roots(path_env));
    roots
}

/// npm shims and Unix symlinks both lead to a dependency closure beside the
/// launcher: probe `dsh`, `dsh.cmd`, `dsh.exe` and `dsh.ps1` per `PATH` entry
/// (`;`-delimited on Windows), push the sibling node_modules candidates, then
/// realpath the launcher (an unreadable one is tolerated) and walk upward,
/// pushing every `node_modules` and `…/@deepseek-ai/dsh/node_modules` closure.
/// Memoized per exact `PATH` string, like the JS `launcherRootsMemo`.
pub fn dsh_launcher_module_roots(path_env: &str) -> Vec<PathBuf> {
    fn memo() -> &'static Mutex<HashMap<String, Vec<PathBuf>>> {
        static MEMO: OnceLock<Mutex<HashMap<String, Vec<PathBuf>>>> = OnceLock::new();
        MEMO.get_or_init(|| Mutex::new(HashMap::new()))
    }
    let mut guard = memo().lock().expect("launcher roots memo poisoned");
    if let Some(cached) = guard.get(path_env) {
        return cached.clone();
    }
    let roots = launcher_module_roots_uncached(path_env);
    guard.insert(path_env.to_string(), roots.clone());
    roots
}

fn launcher_module_roots_uncached(path_env: &str) -> Vec<PathBuf> {
    fn is_node_modules(path: &Path) -> bool {
        path.file_name() == Some(OsStr::new("node_modules"))
    }

    fn is_dsh_package(path: &Path) -> bool {
        path.file_name() == Some(OsStr::new("dsh"))
            && path.parent().and_then(Path::file_name) == Some(OsStr::new("@deepseek-ai"))
    }

    let mut roots = Vec::new();
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let delimiter = if cfg!(windows) { ';' } else { ':' };
    for dir in path_env.split(delimiter) {
        if dir.is_empty() {
            continue;
        }
        let dir = Path::new(dir);
        for base in ["dsh", "dsh.cmd", "dsh.exe", "dsh.ps1"] {
            let launcher = dir.join(base);
            if !launcher.exists() {
                continue;
            }
            let sibling = dir.join("node_modules");
            push_existing(sibling.clone(), &mut seen, &mut roots);
            push_existing(
                sibling.join("@deepseek-ai").join("dsh").join("node_modules"),
                &mut seen,
                &mut roots,
            );
            // `dunce` so Windows canonicalization yields `D:\…`, not the
            // verbatim `\\?\D:\…` form std returns — Node's realpathSync never
            // produces verbatim paths, and the basename walk below depends on
            // the shape.
            let real = dunce::canonicalize(&launcher).unwrap_or_else(|_| launcher.clone());
            let mut cur: &Path = real.parent().unwrap_or_else(|| Path::new(""));
            loop {
                if is_node_modules(cur) {
                    push_existing(cur.to_path_buf(), &mut seen, &mut roots);
                }
                if is_dsh_package(cur) {
                    push_existing(cur.join("node_modules"), &mut seen, &mut roots);
                }
                match cur.parent() {
                    Some(parent) => cur = parent,
                    None => break,
                }
            }
        }
    }
    roots
}

fn push_existing(root: PathBuf, seen: &mut HashSet<PathBuf>, roots: &mut Vec<PathBuf>) {
    if seen.contains(&root) || !root.exists() {
        return;
    }
    seen.insert(root.clone());
    roots.push(root);
}

fn sorted_readdir(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = match std::fs::read_dir(dir) {
        Ok(entries) => entries
            .filter_map(|entry| entry.ok().and_then(|e| e.file_name().into_string().ok()))
            .collect(),
        Err(_) => return Vec::new(),
    };
    names.sort();
    names
}

// ------------------------------------------------------------------ manifest

/// Resolve the root import without asking Node to execute a deployment
/// package (`packageEntryOf`): `exports["."] ?? exports`; a string wins;
/// else the first of `default, import, node, require`; else `module`;
/// else `main`.
pub fn package_entry_of(manifest: &serde_json::Value) -> Option<String> {
    let exports_field = manifest.get("exports");
    let root: Option<&serde_json::Value> = match exports_field {
        Some(value) if !value.is_null() && value.is_object() => {
            Some(value.get(".").filter(|dot| !dot.is_null()).unwrap_or(value))
        }
        other => other,
    };
    if let Some(entry) = root.and_then(serde_json::Value::as_str) {
        return Some(entry.to_owned());
    }
    if let Some(conditions) = root
        .filter(|value| !value.is_null())
        .and_then(serde_json::Value::as_object)
    {
        for key in ["default", "import", "node", "require"] {
            if let Some(entry) = conditions.get(key).and_then(serde_json::Value::as_str) {
                return Some(entry.to_owned());
            }
        }
    }
    if let Some(entry) = manifest.get("module").and_then(serde_json::Value::as_str) {
        return Some(entry.to_owned());
    }
    if let Some(entry) = manifest.get("main").and_then(serde_json::Value::as_str) {
        return Some(entry.to_owned());
    }
    None
}

/// First root whose `<root>/<package>/package.json` parses and yields an
/// existing entry file; unparseable manifests are silently skipped.
pub fn resolve_dsh_package(package_name: &str, roots: &[PathBuf]) -> Option<PackageRef> {
    for root in roots {
        let dir = root.join(package_name);
        let manifest_path = dir.join("package.json");
        if !manifest_path.exists() {
            continue;
        }
        let manifest: serde_json::Value = match std::fs::read_to_string(&manifest_path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
        {
            Some(manifest) => manifest,
            None => continue,
        };
        let Some(entry) = package_entry_of(&manifest) else {
            continue;
        };
        // Node's path.join normalizes `.` segments; Path::join does not, and
        // the segment would survive into the baked `file:` URL (golden-gate
        // catch). Mirror the JS join semantics here.
        let entry = entry.strip_prefix("./").unwrap_or(&entry);
        let file = match entry {
            "" | "." => dir.to_path_buf(),
            _ => dir.join(entry),
        };
        if !file.exists() {
            continue;
        }
        let version = manifest
            .get("version")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("unknown")
            .to_owned();
        return Some(PackageRef {
            file,
            root: root.clone(),
            version,
        });
    }
    None
}

// --------------------------------------------------------------------- URLs

/// Node's `pathToFileURL(path).href`, reproduced byte-for-byte — the CLI bakes
/// these URLs into the lane host module, so the port must not diverge.
///
/// The percent-encode set (measured against Node 24 / ada, see the unit
/// tests): C0 controls, DEL, space, `"`, `#`, `%`, `<`, `>`, `?`, `[`, `]`,
/// `^`, `` ` ``, `{`, `|`, `}`; every non-ASCII byte encodes as UTF-8. All
/// other printable ASCII passes through and `/` stays a separator. On Windows
/// `\` is a separator too, drive paths become `file:///D:/…` and UNC paths
/// `file://server/share/…`. Like Node, a relative input resolves against the
/// current directory and a trailing separator on the input is preserved.
pub fn path_to_file_url(path: &Path) -> String {
    let windows = cfg!(windows);
    let raw = path.as_os_str().as_encoded_bytes();
    let had_trailing_separator =
        raw.last() == Some(&b'/') || (windows && raw.last() == Some(&b'\\'));

    let resolved = if path.is_absolute() {
        path.to_path_buf()
    } else {
        match std::env::current_dir() {
            Ok(cwd) => cwd.join(path),
            Err(_) => path.to_path_buf(),
        }
    };
    let mut text = resolved.to_string_lossy().replace('\\', "/");
    if had_trailing_separator && !text.ends_with('/') {
        text.push('/');
    }

    if windows && text.starts_with("//") {
        // UNC: //server/share/x -> file://server/share/x
        let rest = text.trim_start_matches('/');
        return format!("file://{}", encode_url_path(rest));
    }
    if windows {
        // Drive path: D:/x/y -> file:///D:/x/y
        return format!("file:///{}", encode_url_path(&text));
    }
    // POSIX absolute: /tmp/x -> file:///tmp/x
    format!("file://{}", encode_url_path(&text))
}

fn encode_url_path(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for &byte in text.as_bytes() {
        match byte {
            b'!' | b'$' | b'&' | b'\'' | b'(' | b')' | b'*' | b'+' | b',' | b'-' | b'.'
            | b'/' | b'0'..=b'9' | b':' | b';' | b'=' | b'@' | b'A'..=b'Z' | b'_'
            | b'a'..=b'z' | b'~' => out.push(byte as char),
            _ => {
                out.push('%');
                out.push_str(&format!("{byte:02X}"));
            }
        }
    }
    out
}

// ---------------------------------------------------------------- resolution

/// Return the `file:` imports to bake into a lane host, before the installer
/// writes anything. Production entry: reads `PATH` and
/// `MY_WORKBENCH_DSH_NODE_MODULES` from the environment, exactly like the JS.
pub fn resolve_lane_dependencies(
    home: &Path,
    deps: &BTreeMap<String, String>,
) -> Result<BTreeMap<String, String>, WorkbenchError> {
    let path_env = std::env::var("PATH").unwrap_or_default();
    let env_modules = std::env::var("MY_WORKBENCH_DSH_NODE_MODULES")
        .ok()
        .filter(|value| !value.is_empty());
    resolve_lane_dependencies_in(
        home,
        deps,
        &path_env,
        env_modules.as_deref().map(Path::new),
    )
}

/// Parameter-injected variant of [`resolve_lane_dependencies`] — same
/// behavior, with the environment supplied by the caller (tests, hosts that
/// carry their own env snapshot).
pub fn resolve_lane_dependencies_in(
    home: &Path,
    deps: &BTreeMap<String, String>,
    path_env: &str,
    env_modules: Option<&Path>,
) -> Result<BTreeMap<String, String>, WorkbenchError> {
    let roots = dsh_module_roots(home, path_env, env_modules);
    let launcher_roots = dsh_launcher_module_roots(path_env);
    let mut specifiers = BTreeMap::new();
    for (alias, package_name) in deps {
        let Some(found) = resolve_dsh_package(package_name, &roots) else {
            let launcher_note = if launcher_roots.is_empty() {
                "no 'dsh' launcher was found on PATH"
            } else {
                "the 'dsh' install on PATH was searched too but does not carry it"
            };
            let searched = roots
                .iter()
                .map(|root| root.display().to_string())
                .collect::<Vec<_>>()
                .join(", ");
            return Err(WorkbenchError::Message(format!(
                "cannot resolve '{package_name}' for the DSH lane plugin; searched: {searched}. \
                 {launcher_note}. Start DSH once so it heals <DSH_HOME>/profiles/node_modules, set \
                 MY_WORKBENCH_DSH_NODE_MODULES to a node_modules that carries the package, or link \
                 the package into the preset by hand (docs/dsh-lane-plugin/PLAN.md §5)."
            )));
        };
        specifiers.insert(alias.clone(), path_to_file_url(&found.file));
    }
    Ok(specifiers)
}

// --------------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// `{ tools: '@deepseek-ai/dsh-tools', schema: '@deepseek-ai/schemastery' }`
    /// — the alias map of `test/dsh-deps.test.js`.
    fn deps() -> BTreeMap<String, String> {
        [
            ("tools", "@deepseek-ai/dsh-tools"),
            ("schema", "@deepseek-ai/schemastery"),
        ]
        .into_iter()
        .map(|(alias, package)| (alias.to_owned(), package.to_owned()))
        .collect()
    }

    /// The JS `packageAt` helper: a minimal package with a `1.0.0` version and
    /// the given `exports` field; the entry file is created beside it.
    fn package_at(root: &Path, name: &str, exports_field: &serde_json::Value) -> PathBuf {
        let dir = root.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        let manifest = json!({ "version": "1.0.0", "exports": exports_field });
        std::fs::write(dir.join("package.json"), manifest.to_string()).unwrap();
        let entry = match exports_field {
            serde_json::Value::String(entry) => entry.clone(),
            other => other
                .get("import")
                .and_then(serde_json::Value::as_str)
                .expect("test exports carry an import condition")
                .to_owned(),
        };
        // Mirror the production join semantics (JS join normalizes `.`), so
        // the returned path matches what resolve_dsh_package now produces.
        let entry = entry.strip_prefix("./").unwrap_or(&entry);
        let file = match entry {
            "" | "." => dir.to_path_buf(),
            _ => dir.join(entry),
        };
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "export default {}\n").unwrap();
        file
    }

    // -- dshModuleRoots order ------------------------------------------------

    #[test]
    fn roots_start_at_the_profile_closure_then_fallback_then_env_then_launcher() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        std::fs::create_dir_all(home.join("profiles").join("beta")).unwrap();
        std::fs::create_dir_all(home.join("profiles").join("alpha")).unwrap();
        std::fs::create_dir_all(home.join("profiles").join("node_modules")).unwrap();
        std::fs::write(home.join("profiles").join("loose.txt"), "not a profile").unwrap();
        let fallback = dir.path().join("fallback");

        let roots = dsh_module_roots(&home, "", Some(&fallback));
        let profiles = home.join("profiles");
        // The `node_modules` directory itself passes the isDirectory filter and
        // contributes its own pair of roots, exactly like the JS.
        assert_eq!(
            roots,
            vec![
                profiles.join("node_modules"),
                profiles.join("alpha").join("node_modules"),
                profiles.join("alpha").join(".dsh-module-fallback").join("node_modules"),
                profiles.join("beta").join("node_modules"),
                profiles.join("beta").join(".dsh-module-fallback").join("node_modules"),
                profiles.join("node_modules").join("node_modules"),
                profiles.join("node_modules").join(".dsh-module-fallback").join("node_modules"),
                fallback,
            ],
            "profile dirs are sorted, env modules come last, no launcher roots for an empty PATH"
        );
    }

    #[test]
    fn an_empty_env_modules_value_is_falsy_like_the_js() {
        let dir = tempfile::tempdir().unwrap();
        let roots = dsh_module_roots(&dir.path().join("home"), "", Some(Path::new("")));
        assert!(roots.len() == 1, "only the profile closure root remains: {roots:?}");
    }

    // -- scenario 1: profile closure beats the explicit fallback --------------

    #[test]
    fn profile_closure_resolves_the_esm_entry_and_wins_over_the_fallback() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        let profile_root = home.join("profiles").join("node_modules");
        let fallback = dir.path().join("fallback");
        let tools_file = package_at(&profile_root, "@deepseek-ai/dsh-tools", &json!("./index.mjs"));
        let schema_file = package_at(
            &profile_root,
            "@deepseek-ai/schemastery",
            &json!({ "require": "./index.cjs", "import": "./index.mjs" }),
        );
        package_at(&fallback, "@deepseek-ai/dsh-tools", &json!("./index.mjs"));

        let roots = dsh_module_roots(&home, "", Some(&fallback));
        assert_eq!(roots[0], profile_root);

        let result = resolve_lane_dependencies_in(&home, &deps(), "", Some(&fallback)).unwrap();
        assert_eq!(result["tools"], path_to_file_url(&tools_file));
        assert_eq!(result["schema"], path_to_file_url(&schema_file));
        assert!(result["schema"].ends_with("/index.mjs"), "{}", result["schema"]);
    }

    // -- scenario 2: launcher shims, without executing them -------------------

    #[test]
    fn unstarted_dsh_resolves_packages_from_its_launcher_install_without_executing_it() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        let bin = dir.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("dsh.cmd"), "not an executable command").unwrap();
        let closure = bin
            .join("node_modules")
            .join("@deepseek-ai")
            .join("dsh")
            .join("node_modules");
        let tools_file = package_at(&closure, "@deepseek-ai/dsh-tools", &json!("./index.mjs"));
        package_at(&closure, "@deepseek-ai/schemastery", &json!("./index.mjs"));

        let path_env = bin.to_string_lossy().into_owned();
        let result = resolve_lane_dependencies_in(&home, &deps(), &path_env, None).unwrap();
        assert_eq!(result["tools"], path_to_file_url(&tools_file));
    }

    #[test]
    #[cfg(windows)]
    fn every_windows_shim_name_leads_to_the_sibling_closure() {
        for base in ["dsh", "dsh.cmd", "dsh.exe", "dsh.ps1"] {
            let dir = tempfile::tempdir().unwrap();
            let home = dir.path().join("home");
            let bin = dir.path().join("bin");
            std::fs::create_dir_all(&bin).unwrap();
            std::fs::write(bin.join(base), "not an executable command").unwrap();
            let sibling = bin.join("node_modules");
            let tools_file = package_at(&sibling, "@deepseek-ai/dsh-tools", &json!("./index.mjs"));
            package_at(&sibling, "@deepseek-ai/schemastery", &json!("./index.mjs"));

            let path_env = bin.to_string_lossy().into_owned();
            let result = resolve_lane_dependencies_in(&home, &deps(), &path_env, None).unwrap();
            assert_eq!(result["tools"], path_to_file_url(&tools_file), "shim {base}");
        }
    }

    #[test]
    #[cfg(windows)]
    fn sibling_candidates_are_pushed_regardless_of_the_realpath_walk() {
        // The JS wraps realpathSync in try/catch; dunce::canonicalize failing
        // must degrade to walking up from the launcher path itself.
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("dsh.cmd"), "not an executable command").unwrap();
        let sibling = bin.join("node_modules");
        let tools_file = package_at(&sibling, "@deepseek-ai/dsh-tools", &json!("./index.mjs"));
        package_at(&sibling, "@deepseek-ai/schemastery", &json!("./index.mjs"));

        let roots = dsh_launcher_module_roots(&bin.to_string_lossy());
        let sibling = tools_file
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap();
        assert!(roots.iter().any(|root| root == sibling));
    }

    #[test]
    #[cfg(unix)]
    fn a_symlinked_launcher_resolves_through_its_realpath_closure() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        let bin = dir.path().join("bin");
        let store = dir.path().join("store").join("node_modules");
        std::fs::create_dir_all(&bin).unwrap();
        let real_launcher = store
            .join("@deepseek-ai")
            .join("dsh")
            .join("bin")
            .join("dsh.js");
        std::fs::create_dir_all(real_launcher.parent().unwrap()).unwrap();
        std::fs::write(&real_launcher, "inert").unwrap();
        symlink(&real_launcher, bin.join("dsh")).unwrap();
        let tools_file = package_at(&store, "@deepseek-ai/dsh-tools", &json!("./index.mjs"));
        package_at(&store, "@deepseek-ai/schemastery", &json!("./index.mjs"));

        let path_env = bin.to_string_lossy().into_owned();
        let result = resolve_lane_dependencies_in(&home, &deps(), &path_env, None).unwrap();
        assert_eq!(result["tools"], path_to_file_url(&tools_file));
    }

    // -- scenario 3: the missing-dependency error -----------------------------

    #[test]
    fn missing_dependency_reports_the_searched_roots_and_the_launcher_note() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        let error = resolve_lane_dependencies_in(&home, &deps(), "", None).unwrap_err();
        let text = error.to_string();
        assert!(
            text.contains(
                &home
                    .join("profiles")
                    .join("node_modules")
                    .display()
                    .to_string()
            ),
            "the searched list leads with the profile closure: {text}"
        );
        assert!(text.contains("no 'dsh' launcher was found on PATH"), "{text}");
        // BTreeMap iteration is alphabetical, so `schema` resolves first and is
        // the package named when both are missing (the JS iterates insertion
        // order and would name `tools`; the searched list and notes are identical).
        assert!(
            text.contains("cannot resolve '@deepseek-ai/schemastery' for the DSH lane plugin"),
            "{text}"
        );
        assert!(text.contains("docs/dsh-lane-plugin/PLAN.md §5"), "{text}");
    }

    #[test]
    fn missing_dependency_names_the_launcher_install_when_one_is_on_the_path() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        let bin = dir.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("dsh.cmd"), "not an executable command").unwrap();
        // A launcher root only counts once the sibling node_modules exists —
        // one that carries everything BUT the missing package.
        std::fs::create_dir_all(bin.join("node_modules").join("other-pkg")).unwrap();
        let path_env = bin.to_string_lossy().into_owned();
        let error = resolve_lane_dependencies_in(&home, &deps(), &path_env, None).unwrap_err();
        let text = error.to_string();
        assert!(
            text.contains("the 'dsh' install on PATH was searched too but does not carry it"),
            "{text}"
        );
        assert!(text.contains(&bin.join("node_modules").display().to_string()), "{text}");
    }

    // -- packageEntryOf -------------------------------------------------------

    #[test]
    fn package_entry_of_prefers_strings_then_condition_keys_then_module_then_main() {
        let entry = |value: serde_json::Value| package_entry_of(&value);
        assert_eq!(entry(json!({ "exports": "./a.mjs" })), Some("./a.mjs".to_owned()));
        assert_eq!(
            entry(json!({ "exports": { ".": "./root.mjs" } })),
            Some("./root.mjs".to_owned())
        );
        // Condition-key order is fixed: default, import, node, require.
        assert_eq!(
            entry(json!({ "exports": { "require": "./r.cjs", "default": "./d.js" } })),
            Some("./d.js".to_owned())
        );
        assert_eq!(
            entry(json!({ "exports": { "import": "./i.mjs", "require": "./r.cjs" } })),
            Some("./i.mjs".to_owned())
        );
        assert_eq!(
            entry(json!({ "exports": { "node": "./n.js" } })),
            Some("./n.js".to_owned())
        );
        // A null "." falls back to the whole exports object (?? semantics).
        assert_eq!(
            entry(json!({ "exports": { ".": null, "import": "./i.mjs" } })),
            Some("./i.mjs".to_owned())
        );
        // A nested condition object under "." is consulted the same way.
        assert_eq!(
            entry(json!({ "exports": { ".": { "import": "./deep.mjs" } } })),
            Some("./deep.mjs".to_owned())
        );
        assert_eq!(entry(json!({ "module": "./m.js" })), Some("./m.js".to_owned()));
        assert_eq!(entry(json!({ "main": "./main.js" })), Some("./main.js".to_owned()));
        assert_eq!(entry(json!({})), None);
        assert_eq!(entry(json!({ "exports": 42 })), None);
        assert_eq!(entry(json!({ "exports": { ".": null } })), None);
        assert_eq!(entry(json!({ "exports": [] })), None);
    }

    // -- file: URL baking ------------------------------------------------------

    #[test]
    #[cfg(windows)]
    fn file_urls_match_node_path_to_file_url_byte_for_byte() {
        let url = |path: &str| path_to_file_url(Path::new(path));
        // The exact outputs of `node -e "pathToFileURL(...).href"` on Node 24.
        assert_eq!(url("D:\\x y\\z.js"), "file:///D:/x%20y/z.js");
        assert_eq!(url("D:\\a%b\\c.js"), "file:///D:/a%25b/c.js");
        assert_eq!(url("C:\\p\\中文.md"), "file:///C:/p/%E4%B8%AD%E6%96%87.md");
        assert_eq!(url("D:\\q#r\\s?t.js"), "file:///D:/q%23r/s%3Ft.js");
        assert_eq!(url("D:\\x\\y\\z|w.js"), "file:///D:/x/y/z%7Cw.js");
        assert_eq!(url("D:\\a\\b\\c\\d.js"), "file:///D:/a/b/c/d.js");
        assert_eq!(url("D:\\a\\{b}\\c`.js"), "file:///D:/a/%7Bb%7D/c%60.js");
        assert_eq!(url("D:\\a\"b<c>e.js"), "file:///D:/a%22b%3Cc%3Ee.js");
        assert_eq!(url("D:\\ends\\"), "file:///D:/ends/");
        assert_eq!(url("\\\\server\\share\\x.js"), "file://server/share/x.js");
        assert_eq!(url("D:\\tab\tthere.js"), "file:///D:/tab%09there.js");
        assert_eq!(url("D:\\a^b.js"), "file:///D:/a%5Eb.js");
        assert_eq!(url("D:\\a[b]c.js"), "file:///D:/a%5Bb%5Dc.js");
        assert_eq!(url("D:\\emoji\\🙂.js"), "file:///D:/emoji/%F0%9F%99%82.js");
    }

    #[test]
    #[cfg(not(windows))]
    fn file_urls_match_node_path_to_file_url_byte_for_byte() {
        let url = |path: &str| path_to_file_url(Path::new(path));
        assert_eq!(url("/tmp/foo bar.js"), "file:///tmp/foo%20bar.js");
        assert_eq!(url("/tmp/%42.js"), "file:///tmp/%2542.js");
        assert_eq!(url("/tmp/中文.js"), "file:///tmp/%E4%B8%AD%E6%96%87.js");
    }

    #[test]
    fn resolve_dsh_package_skips_unparseable_manifests_and_missing_entries() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("node_modules");
        std::fs::create_dir_all(root.join("broken")).unwrap();
        std::fs::write(root.join("broken").join("package.json"), "{not json").unwrap();
        std::fs::create_dir_all(root.join("no-entry")).unwrap();
        std::fs::write(
            root.join("no-entry").join("package.json"),
            json!({ "version": "1.0.0", "main": "./absent.js" }).to_string(),
        )
        .unwrap();
        let good = package_at(&root, "@deepseek-ai/dsh-tools", &json!("./index.mjs"));

        let found = resolve_dsh_package("@deepseek-ai/dsh-tools", &[root.clone()]).unwrap();
        assert_eq!(found.file, good);
        assert_eq!(found.root, root);
        assert_eq!(found.version, "1.0.0");

        let missing = resolve_dsh_package("@deepseek-ai/absent", &[root]);
        assert!(missing.is_none());
    }

    #[test]
    fn resolve_dsh_package_reports_unknown_versions_as_unknown() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("node_modules");
        let dir = root.join("pkg");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("package.json"), json!({ "main": "./i.js" }).to_string()).unwrap();
        std::fs::write(dir.join("i.js"), "").unwrap();
        let found = resolve_dsh_package("pkg", std::slice::from_ref(&root)).unwrap();
        assert_eq!(found.version, "unknown");
    }
}
