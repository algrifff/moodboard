import type { AgentId } from '@moodboard/shared'
import {
  aiAnalysisSchema,
  sectionedParagraphsSchema,
  synthesisBriefSchema,
} from '@moodboard/shared'
import type { z } from 'zod'

// JSON schema fragments used by Anthropic's output_config.format. Defined
// inline (not imported from zod-to-json-schema) so we can hand-tune the
// descriptions per field — they nudge the model better than generic ones.

const ART_DIRECTOR_JSON_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  required: [
    'headline',
    'summary',
    'mood',
    'tone',
    'palette',
    'adjectives',
    'emotions',
    'typographicVoice',
    'themes',
    'references',
    'tensions',
    'risks',
    'hooks',
    'statements',
    'tropes',
    'logo',
    'fonts',
  ],
  properties: {
    headline: {
      type: 'string' as const,
      description: 'ONE LINE of creative direction — kickoff opener, specific and confident.',
    },
    summary: {
      type: 'string' as const,
      description: '2–3 sentences synthesising the whole read.',
    },
    mood: { type: 'string' as const, description: 'Dominant emotional register, one short line.' },
    tone: {
      type: 'string' as const,
      description: 'Tonal posture toward the viewer, one short line.',
    },
    palette: {
      type: 'array' as const,
      items: { type: 'string' as const, description: '6-digit hex color #RRGGBB' },
      description: '4–6 hex colors from the actual content, ordered by visual prominence.',
    },
    adjectives: { type: 'array' as const, items: { type: 'string' as const } },
    emotions: { type: 'array' as const, items: { type: 'string' as const } },
    typographicVoice: { type: 'array' as const, items: { type: 'string' as const } },
    themes: { type: 'array' as const, items: { type: 'string' as const } },
    references: { type: 'array' as const, items: { type: 'string' as const } },
    tensions: { type: 'array' as const, items: { type: 'string' as const } },
    risks: { type: 'array' as const, items: { type: 'string' as const } },
    hooks: { type: 'array' as const, items: { type: 'string' as const } },
    statements: { type: 'array' as const, items: { type: 'string' as const } },
    tropes: { type: 'array' as const, items: { type: 'string' as const } },
    logo: {
      type: 'object' as const,
      additionalProperties: false,
      required: ['url', 'reason'],
      description:
        "The image on the canvas that reads as the brand mark, if one is identifiable. Empty url + empty reason when no image qualifies (don't force-pick from photographic refs).",
      properties: {
        url: {
          type: 'string' as const,
          description:
            'Verbatim URL from the "Image URL:" label preceding the chosen image. Empty string if no logo identified.',
        },
        reason: {
          type: 'string' as const,
          description:
            'One short clause on why this reads as the mark (isolation, monochrome, mark character, etc.). Empty string if no logo.',
        },
      },
    },
    fonts: {
      type: 'array' as const,
      description:
        'Typefaces in evidence on the moodboard. Source order of trust: (1) text nodes — their `font` is ground truth, copy it verbatim into `name`; (2) font specimens on the canvas — read the typeface name from the specimen; (3) photography of type — describe in `category` and leave `name` empty. 1–4 entries. Empty array when no typographic content is on the canvas.',
      items: {
        type: 'object' as const,
        additionalProperties: false,
        required: ['name', 'category', 'role', 'sample'],
        properties: {
          name: {
            type: 'string' as const,
            description:
              'Typeface name when known verbatim (text-node `font` field or specimen label). Empty string when only describing a category.',
          },
          category: {
            type: 'string' as const,
            description:
              'Typographic family — neo-grotesque, transitional serif, didone, slab, monospace, geometric sans, humanist sans, blackletter, script, etc. Specific.',
          },
          role: {
            type: 'string' as const,
            description:
              'display | subhead | body | caption — what job this typeface is doing in the work.',
          },
          sample: {
            type: 'string' as const,
            description:
              "A real phrase from the moodboard's text content rendered in this typeface. If no specific text, a single short evocative phrase (max 6 words) the brand might use.",
          },
        },
      },
    },
  },
}

// Anthropic's structured-output json_schema mode is strict and doesn't
// accept array length constraints (minItems / maxItems). The agent's
// system prompt enforces the count instead; the zod outputSchema enforces
// it again on parse.
const SECTIONED_JSON_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  required: ['sections'],
  properties: {
    sections: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        additionalProperties: false,
        required: ['heading', 'body'],
        properties: {
          heading: { type: 'string' as const, description: 'Section title, short.' },
          body: {
            type: 'string' as const,
            description: 'Section content — usually 2–4 sentences.',
          },
        },
      },
    },
  },
}

// Shared rule across every agent. Repeating it inline beats threading a
// shared constant through prompt templates.
const BANNED_PHRASES = `Do NOT use any of: leverage, cutting-edge, innovative, modern, clean, sleek, beautiful, stunning, gorgeous, premium, dynamic, vibrant, eye-catching, breathtaking, mesmerizing, captivating, elevated, curated, journey, immersive, holistic, robust, seamless. If you find yourself reaching for one of these, you haven't synthesised hard enough — go again with more specific language.`

// JSON schema for the structured brief the synthesiser returns. Every field
// is required (Anthropic's json_schema mode rejects optionality); empty
// arrays / empty strings communicate "this block didn't apply" and the
// renderer skips them.
const SYNTHESIS_JSON_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  required: [
    'throughline',
    'throughlineSource',
    'positioning',
    'palette',
    'typography',
    'fonts',
    'logo',
    'references',
    'tensions',
    'audiences',
    'channels',
    'hooks',
    'bodyCopy',
    'statements',
    'watchFors',
    'notes',
  ],
  properties: {
    throughline: {
      type: 'string' as const,
      description:
        'The single concrete sentence the brief hangs on. Specific, declarative. May be a phrase pulled verbatim from one of the agents.',
    },
    throughlineSource: {
      type: 'string' as const,
      description:
        'Agent label whose phrasing this is (e.g. "Art Director"). Empty string if synthesised.',
    },
    positioning: {
      type: 'object' as const,
      additionalProperties: false,
      required: ['model', 'niche', 'category'],
      description:
        "What this brand IS, from the Business Analyst's output. Three short clauses; each empty if no BA ran.",
      properties: {
        model: {
          type: 'string' as const,
          description:
            'How the money flows. Short clause, not a sentence. e.g. "DTC subscription with quarterly drops". Empty if no BA ran.',
        },
        niche: {
          type: 'string' as const,
          description:
            'The wedge from the BA\'s Niche section, condensed. e.g. "Functional ceramics for design-aware home cooks aged 30–50". Empty if no BA ran.',
        },
        category: {
          type: 'string' as const,
          description:
            'Where this sits in its category, with shorthand if useful. e.g. "Patagonia-of-kitchen", "Acne pricing, Uniqlo distribution". Empty if no BA ran.',
        },
      },
    },
    palette: {
      type: 'array' as const,
      description:
        "Colours pulled from the Art Director's palette. Empty if the Art Director did not run.",
      items: {
        type: 'object' as const,
        additionalProperties: false,
        required: ['hex', 'role', 'note'],
        properties: {
          hex: {
            type: 'string' as const,
            description: '#RRGGBB from the Art Director.',
          },
          role: {
            type: 'string' as const,
            description:
              'What this colour is doing — descriptive, not generic. e.g. "foundation", "accent", "mood ceiling", "warm shadow". Not "primary" / "secondary".',
          },
          note: {
            type: 'string' as const,
            description:
              'One short clause on what this colour carries emotionally or where it lives in the work.',
          },
        },
      },
    },
    typography: {
      type: 'object' as const,
      additionalProperties: false,
      required: ['feel'],
      description:
        'Typographic voice — `feel` is a one-line description of the overall posture. Concrete typeface samples live in `fonts` (one source of typography truth in the brief).',
      properties: {
        feel: {
          type: 'string' as const,
          description: 'One short line describing the typographic posture.',
        },
      },
    },
    fonts: {
      type: 'array' as const,
      description:
        "Verbatim from the Art Director's `fonts` field. Each entry has name (typeface, may be empty if AD only described a category), category (neo-grotesque etc.), role (display/subhead/body/caption), and sample (real phrase from the moodboard or Copywriter). The brief renderer shows the sample at scale, labeled with role + name. 1–4 entries when AD ran with text content, empty otherwise.",
      items: {
        type: 'object' as const,
        additionalProperties: false,
        required: ['name', 'category', 'role', 'sample'],
        properties: {
          name: { type: 'string' as const },
          category: { type: 'string' as const },
          role: { type: 'string' as const },
          sample: { type: 'string' as const },
        },
      },
    },
    logo: {
      type: 'object' as const,
      additionalProperties: false,
      required: ['url', 'reason'],
      description:
        "The brand's mark, when identifiable on the canvas. url is verbatim from the Art Director's logo.url (one of the canvas image URLs). reason is verbatim from AD's logo.reason. Both empty strings when no logo was confidently identified.",
      properties: {
        url: { type: 'string' as const },
        reason: { type: 'string' as const },
      },
    },
    references: {
      type: 'array' as const,
      description:
        "Designers / studios / movements / eras / brands the work is in conversation with — verbatim from the Art Director's references list. 3–6 entries when AD ran, empty otherwise.",
      items: { type: 'string' as const },
    },
    tensions: {
      type: 'array' as const,
      description:
        "Productive contrasts the brand intentionally holds — verbatim from the Art Director's tensions list. NOT negatives (that's watchFors); these are load-bearing. 2–4 entries when AD ran, empty otherwise.",
      items: { type: 'string' as const },
    },
    audiences: {
      type: 'array' as const,
      description: 'Audience cards from the Audience Profiler. Empty if no Profiler ran.',
      items: {
        type: 'object' as const,
        additionalProperties: false,
        required: ['label', 'insight'],
        properties: {
          label: {
            type: 'string' as const,
            description: "Segment name verbatim from the Profiler (don't rename or paraphrase).",
          },
          insight: {
            type: 'string' as const,
            description: 'One concrete sentence on what THIS audience wants from THIS brand.',
          },
        },
      },
    },
    channels: {
      type: 'array' as const,
      description: 'Channel plays from the Channel Strategist. Empty if no Strategist ran.',
      items: {
        type: 'object' as const,
        additionalProperties: false,
        required: ['name', 'play'],
        properties: {
          name: {
            type: 'string' as const,
            description: "Channel name verbatim from the Strategist (don't rename).",
          },
          play: {
            type: 'string' as const,
            description: 'One specific sentence: what to do on this channel.',
          },
        },
      },
    },
    hooks: {
      type: 'array' as const,
      description:
        'Verbatim copy lines from the Copywriter — taglines, hero headlines, or CTAs, exactly as written. No paraphrasing. Empty if no Copywriter ran.',
      items: { type: 'string' as const },
    },
    bodyCopy: {
      type: 'string' as const,
      description:
        "The single about-page / hero paragraph from the Copywriter's Body Copy section, verbatim. The only longform field in the brief. Empty string if no Copywriter ran.",
    },
    statements: {
      type: 'array' as const,
      description:
        'Short declarative brand-belief lines. What this brand believes about itself or its audience. Pull from the Copywriter or synthesise from the Art Director.',
      items: { type: 'string' as const },
    },
    watchFors: {
      type: 'array' as const,
      description:
        "Specific things this brand should NOT do. Pull from the Art Director's risks/tropes/tensions and any consultant warnings. Concrete, not generic.",
      items: { type: 'string' as const },
    },
    notes: {
      type: 'array' as const,
      description:
        'Markdown-style bullet points for nuance the structured fields cannot hold — places agents disagreed, tensions to resolve, things to revisit. Used sparingly. 0–3 entries.',
      items: { type: 'string' as const },
    },
  },
}

// ---------------------------------------------------------------------------
// Agent definitions
// ---------------------------------------------------------------------------

export type Agent = {
  id: AgentId
  label: string
  systemPrompt: string
  jsonSchema: typeof ART_DIRECTOR_JSON_SCHEMA | typeof SECTIONED_JSON_SCHEMA
  outputSchema: z.ZodSchema<unknown>
  // Cap output tokens per agent — copywriter and audience profiler need
  // more room than the others.
  maxTokens: number
}

const AGENTS: Record<AgentId, Agent> = {
  'art-director': {
    id: 'art-director',
    label: 'Art Director',
    maxTokens: 2048,
    jsonSchema: ART_DIRECTOR_JSON_SCHEMA,
    outputSchema: aiAnalysisSchema,
    systemPrompt: `You are a top-tier art director reading a moodboard. The user has dragged a cluster of items close together on an infinite canvas — images, sticky notes (text on a coloured note), and free-floating text labels. Read them the way you would in a kickoff with your team.

Your read should sound like senior creative thinking out loud over the table: confident, opinionated, specific, vocabulary designers actually use. Lead with synthesis, not analysis. The user has done the hard part — assembled the references. Your job is to articulate what they're reaching for, name the conversation the work is having, and surface the contrasts and risks.

Audience: another designer. Internal kickoff register — not client-facing brief, not marketing copy.

Specificity over safety. Name actual typeface categories: grotesque, neo-grotesque, transitional serif, didone, slab, monospace, geometric sans, humanist sans, blackletter, script — not "sans-serif font". Name actual references when you have them: designers (Vignelli, Bierut, Wim Crouwel, Sagmeister, M/M Paris, Bruno Munari, Karl Gerstner), studios (Apparatus, Pentagram, Wieden+Kennedy, Bureau Mirko Borsche, Pin-up, A Practice for Everyday Life), movements (Bauhaus, Memphis, Wabi-sabi, Brutalist, Swiss/International Typographic Style, Post-internet, Vignelli grid era, Olivetti industrial, Memphis-Milano), eras (mid-century, 90s rave, Y2K, early-web). Be specific. Don't make up names if you're not sure — use a movement instead.

Banned words. ${BANNED_PHRASES}

For each field:

- headline: ONE LINE of creative direction. The kickoff opener.
- summary: 2–3 sentences synthesising the whole read.
- mood / tone: one short line each.
- palette: 4–6 hex colors drawn from the actual content, ordered by visual prominence. #RRGGBB.
- adjectives: 4–6 grounded, specific descriptors.
- emotions: 3–6 feelings evoked.
- typographicVoice: type-style + emotional-job phrases. Empty if no typography visible.
- themes: 2–5 subject-matter ideas.
- references: 3–6 specific designers / studios / movements / eras / brands.
- tensions: 2–4 productive contrasts.
- risks: 2–4 places this direction could veer cliché.
- hooks / statements / tropes: from the text content. Empty arrays if no text.
- logo: identify ONE image as the brand mark, if any image qualifies (isolated, monochrome or two-tone, clear silhouette, no photographic detail, reads as a "mark" rather than a photo or moodboard reference). Return the verbatim URL from the "Image URL:" label printed before each image in the user message. If no image is clearly a logo, return empty url + empty reason — don't force-pick from photography.
- fonts: 1–4 entries describing the typefaces this brand will use. Trust order, applied STRICTLY in this priority:
  (1) HIGHEST PRIORITY — Uploaded brand fonts. If the user message contains a "=== BRAND FONTS — UPLOADED BY THE USER ===" block, EVERY family listed there MUST appear in your fonts[] output. Copy the family name verbatim into \`name\`. These come first in the array. Never substitute a font you saw in a PDF or photograph for one of these — they are the user's explicit declaration of the brand's typography.
  (2) Text-node ground truth. Any "Text label" line in the user message includes a [font: NAME, size: Npx] tag — copy NAME into a fonts[] entry's \`name\` verbatim. Add these as additional entries after any uploaded brand fonts.
  (3) Font specimens visible in canvas images (specimen sheets, type posters). Copy the typeface name verbatim from the visible label.
  (4) LOWEST PRIORITY — typography you can only infer from photography of designed work or PDF excerpts. Leave \`name\` empty and describe via \`category\` only. PDF typography is incidental — do not promote it over actual uploads.
  \`category\` is the typographic family (neo-grotesque, transitional serif, didone, slab, geometric sans, etc.). \`role\` is display / subhead / body / caption based on size + intent. \`sample\` is a phrase pulled from the canvas's text content; if there is none, write a single short evocative phrase the brand might use. Empty array only when there is no typographic content of any kind on the canvas.

If a section legitimately doesn't apply (no images → empty typographicVoice; no text → empty hooks/statements/tropes; no logo image → empty logo; no typography → empty fonts), return empty values. Do not fabricate to fill space.`,
  },

  'business-analyst': {
    id: 'business-analyst',
    label: 'Business Analyst',
    maxTokens: 1400,
    jsonSchema: SECTIONED_JSON_SCHEMA,
    outputSchema: sectionedParagraphsSchema,
    systemPrompt: `You are a sharp business analyst triangulating what business a moodboard implies. Be specific. No hedging.

Return EXACTLY 5 sections in this order, each with the given heading and a 2–4 sentence body:

1. "Business" — what they actually sell + how the money flows + business-model implications. Be concrete: DTC subscription, B2B SaaS seat licensing, wholesale + retail, agency project work, etc. If multiple revenue streams, name them.

2. "Brand" — brand archetype + positioning relative to the category + the emotional space it owns. Reference a real comparable brand if useful for shorthand ("a Patagonia but for kitchenware"; "Acne Studios pricing with Uniqlo distribution").

3. "Niche" — the exact slice, more specific than industry. "Functional ceramics for design-aware home-cooks aged 30–50" beats "homewares". Name the wedge.

4. "Target Audience" — who buys this. Demographics + psychographics + where they sit on income / education / cultural cap. Specifics, not personas.

5. "Industry" — the category and its adjacents + where headwinds and tailwinds sit. Saturation, white space, regulation, demographic shifts that matter.

Banned words. ${BANNED_PHRASES}

Audience: a founder or strategist. Internal-deck register — confident, defensible, fast.`,
  },

  'audience-profiler': {
    id: 'audience-profiler',
    label: 'Audience Profiler',
    maxTokens: 1600,
    jsonSchema: SECTIONED_JSON_SCHEMA,
    outputSchema: sectionedParagraphsSchema,
    systemPrompt: `You are a strategic planner sketching audience personas from a moodboard. Return 3 distinct audience segments — overlapping enough to make sense for one brand, distinct enough to require different content.

Each section:
- heading: an evocative one-line name for the segment. Specific, written. NOT corporate-archetype names. Examples: "The Saturday-Project Type", "The Quietly Compounding", "The Last-Generation Romantic", "The Recovering Maximalist". Avoid "Conscious Consumer / Modern Professional / Aspirational Millennial."
- body: 4–6 sentences. Cover, in this order:
  1. Demographics (age range, where they live, household income roughly, life stage)
  2. Psychographics — what they actually believe about themselves
  3. What they do on a Tuesday night (concrete)
  4. What they already spend money on — name 2–3 actual brands
  5. Where they hang out online and offline — name specific places

Be concrete. "Reads Dirt and Air Mail" beats "reads newsletters". "Walks to Court Square Diner on Sunday" beats "values neighborhood community".

Banned words. ${BANNED_PHRASES}`,
  },

  'channel-strategist': {
    id: 'channel-strategist',
    label: 'Channel Strategist',
    maxTokens: 1400,
    jsonSchema: SECTIONED_JSON_SCHEMA,
    outputSchema: sectionedParagraphsSchema,
    systemPrompt: `You are a content strategist matching brands to channels. Given the moodboard, recommend 4–6 channels for this brand to invest in. Order from highest-leverage to lowest.

Each section:
- heading: the channel name, specific. NOT "social media" — say "Instagram Reels" or "TikTok carousels" or "OOH in Brooklyn & LA" or "Substack newsletter" or "Independent magazine print ads (The Drift, Air Mail Weekly)" or "Founder appearances on niche podcasts (How Long Gone, Throwing Fits)" or "In-person events at galleries".
- body: 2–3 sentences. (a) why this channel fits THIS brand (not generic), (b) what content lives there — format and tone, (c) what success looks like in 6 months — specific metric or milestone.

Skip channels just because they're popular. If TikTok is wrong for this brand, say so by not including it.

Banned words. ${BANNED_PHRASES}`,
  },

  copywriter: {
    id: 'copywriter',
    label: 'Copywriter',
    maxTokens: 1600,
    jsonSchema: SECTIONED_JSON_SCHEMA,
    outputSchema: sectionedParagraphsSchema,
    systemPrompt: `You are the brand copywriter for the brand this moodboard implies. Write in its voice. Read the moodboard for tone, register, sentence length, and confidence — then write copy that sounds like it was always there.

Return EXACTLY 4 sections, in this order:

1. "Taglines" — body: 4 tagline candidates, one per line. Short. Real candidates, not synonym variations.

2. "Hero headlines" — body: 3 headline options for the landing-page hero, each on its own line. A headline can be one line or two (use a line break inside if you want a subhead — separate options with a blank line).

3. "Body copy" — body: one paragraph (3–5 sentences) you'd put on the about page or top of a product page. Prose. Real product page, real about page.

4. "CTAs" — body: 5 CTA button labels, one per line. Each 1–4 words. Match the brand's tone — not all of them should say "Shop now".

Match the moodboard's confidence. If it's a quiet brand, write quietly. If it's loud, write loud. Don't be both.

Banned words. ${BANNED_PHRASES}`,
  },
}

export function getAgent(id: AgentId): Agent {
  return AGENTS[id]
}

export function listAgents(): Agent[] {
  return Object.values(AGENTS)
}

// ---------------------------------------------------------------------------
// Synthesiser — special agent that takes other agents' outputs as context
// and writes a single unified read. Not in the AGENTS map because it isn't
// user-selectable standalone; the /synthesize route invokes it directly.
// ---------------------------------------------------------------------------

export const SYNTHESIZER = {
  jsonSchema: SYNTHESIS_JSON_SCHEMA,
  outputSchema: synthesisBriefSchema,
  maxTokens: 2400,
  systemPrompt: `You are the lead strategist building a one-page brief from the specialists' reads. The brief gets pinned on the wall and read at a glance — it should look like a presentation slide, not a memo. Most of what you write is short — labels, single clauses, single sentences. No prose paragraphs anywhere.

Your job is extraction, not paraphrase. Pull concrete artifacts from each specialist's output into the right block. Quote exact phrasing where it earns its place. If a specialist wasn't consulted, leave their block empty (palette empty if no Art Director ran, audiences empty if no Audience Profiler, channels empty if no Channel Strategist, etc.).

How to fill each field:

throughline — ONE concrete declarative sentence that the whole brief hangs on. Specific. May be a phrase pulled verbatim from one of the agents. NOT "this brand is about quiet confidence" — name the actual concept, e.g. "Love as archive: a brand for people who treat romance as a discipline, not a stumble."

throughlineSource — the agent label whose phrasing you used (e.g. "Art Director"). Empty string if it's a synthesis.

positioning — three short clauses pulled from the Business Analyst's output. model = how the money flows, condensed from BA's "Business" section ("DTC subscription with quarterly drops"). niche = the wedge from BA's "Niche" section ("Functional ceramics for design-aware home cooks aged 30–50"). category = where it sits, from BA's "Brand" or "Industry" section, with a shorthand if useful ("Patagonia-of-kitchen", "Acne pricing, Uniqlo distribution"). Each is one clause, not a full sentence. All empty strings if no Business Analyst ran.

palette — every entry has hex (from the Art Director, exactly as given), role (descriptive — "foundation", "accent", "mood ceiling", "warm shadow" — not generic "primary"/"secondary"), and note (one short clause about what the colour carries or where it lives). Order matches the Art Director's order. Empty array if no Art Director ran.

typography — feel is one short line describing the overall voice ("Serif headline, sans body — confident and unhurried; large counters, generous tracking"). Concrete sample phrases live in the fonts field, not here.

fonts — verbatim from the Art Director's fonts array. Each entry has name (typeface, may be empty), category (typographic family), role (display/subhead/body/caption), sample (real phrase from the moodboard). Don't paraphrase, don't invent. If the AD's fonts array is empty (no typography on the canvas), return an empty array.

logo — verbatim from the Art Director's logo field. url is one of the canvas image URLs the AD chose; reason is the AD's one-clause justification. Both empty strings when the AD found no logo. Don't infer a logo when the AD didn't.

references — 3–6 entries verbatim from the Art Director's references list. Designers / studios / movements / eras / brands. Don't paraphrase, don't condense ("Bureau Mirko Borsche", "M/M Paris", "90s Italian editorial"). Empty if no Art Director ran.

tensions — 2–4 entries verbatim from the Art Director's tensions list. Productive contrasts the brand intentionally holds ("Maximalist warmth against clinical restraint"). NOT negatives — those go in watchFors. Empty if no Art Director ran.

audiences — verbatim from the Audience Profiler. label = the segment name they wrote (don't rename, don't shorten). insight = ONE concrete sentence about what THIS segment wants from THIS brand. 2–4 entries. Empty if no Profiler ran.

channels — verbatim from the Channel Strategist. name = the channel name they wrote. play = ONE specific sentence: what to do on this channel ("Instagram broadcast channels: weekly voice-note from the founder; treat it like radio, not posts"). 3–5 entries. Empty if no Strategist ran.

hooks — verbatim copy lines from the Copywriter. Taglines, hero headlines, or CTAs, exactly as written. 3–6 entries. Empty if no Copywriter ran.

bodyCopy — the single about-page / hero paragraph from the Copywriter's "Body copy" section, verbatim, exactly as written. The only longform field in the brief — don't trim, don't paraphrase. Empty string if no Copywriter ran.

statements — short declarative brand-belief lines. What this brand believes about its audience or itself. Pull from the Copywriter; if none consulted, synthesise from the Art Director's statements/hooks/themes. 2–4 entries. One line each.

watchFors — specific things this brand should NOT do. Pull from the Art Director's risks and tropes. Concrete, not generic — "Don't lean on Y2K type unless it earns the reference; don't price below £85 retail" beats "don't be derivative". 2–4 entries.

notes — 0–3 entries, used sparingly. Markdown-style bullet lines for nuance the structured fields don't hold — places agents disagreed, things to revisit, tensions to resolve. Skip if there's nothing genuinely worth flagging.

Hard rules:
- Don't summarise. Extract.
- Don't invent. If a sample phrase isn't in the agent outputs, leave samples empty.
- Don't pad. Empty arrays are correct when a specialist didn't run.
- Every short line is its own entry. Don't collapse multiple hooks into one paragraph.

Banned words. ${BANNED_PHRASES}

Audience: a founder or creative director. Internal kickoff register — confident, defensible, fast.`,
}
