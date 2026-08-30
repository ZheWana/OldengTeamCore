// isomorphic-git uses Buffer as a browser-global in a few Git pack/index paths.
// Inject the browser-compatible implementation so mobile Obsidian does not
// depend on Electron's Node.js globals.
export { Buffer } from "buffer";
