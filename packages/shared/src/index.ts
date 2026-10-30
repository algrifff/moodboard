export * from './types'
export * from './schemas'

// URL recognisers — pure functions, used by both the editor's paste
// handler and the MCP server's add_url dispatcher.
export * from './driveUrl'
export * from './spotifyUrl'
export * from './videoUrl'
export * from './webUrl'

// Geometry — proximity grouping, bounding boxes, world/screen transform.
// Used by the editor's canvas and the MCP server's auto-placement +
// analyze_board grouping.
export * from './aabb'
export * from './transform'

// Phase 21 — agent sidebar threads, messages, stream events.
export * from './agent'

// Phase 22 — clients, style kits (tokens → --kit-* CSS), asset library, Linear.
export * from './clients'
export * from './kits'
export * from './kitCss'
export * from './library'
export * from './linear'

// Phase 23 — templates + outputs (HTML), the data-slot contract.
export * from './slots'
export * from './outputs'

// Phase 24 — output agents: design runs, variants, progress.
export * from './design'
