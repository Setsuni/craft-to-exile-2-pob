# Craft to Exile 2 — Path of Building

A build planner for **Craft to Exile 2** (Minecraft Forge 1.20.1, Mine & Slash
6.4.13), in the spirit of Path of Building: plan a tree, configure gear and
skills, and see what the character sheet and the damage actually do.

**→ [Open the planner](https://setsuni.github.io/craft-to-exile-2-pob/)**

Everything is one self-contained HTML file. No server, no build step to use it,
nothing to install.

## What it does

- **Tree** — the full passive tree and the Atlas tree, with the DPS change of a
  node shown on hover, for the node alone and for the whole path to it.
- **Class** — the two-class split and its perk points, laid out the way the
  in-game screen is.
- **Items** — every slot, with bases, affixes and tiers, uniques, runewords and
  runes, gems, corruptions, jewel sockets, the vanilla item underneath and its
  enchantments. The character sheet follows the item you are editing.
- **Skills** — rank, support gems, augments, and how each skill is actually
  used: cast on cooldown, procced on hit at a chance, or not part of the
  rotation.
- **Config** — buffs, charges and conditionals, so a sheet can describe the
  character mid-fight rather than standing still.
- **Calcs** — every stat, next to the value the game itself reports.

## Your builds and saving

A first visit starts with an empty level-1 character. Your named builds are stored
in this browser, independently of other players. Returning opens your last build.

By default, **Save now** creates a checkpoint. When you switch builds, start a new
one, or import a replacement with unsaved changes, choose **Save changes**,
**Discard changes**, or **Cancel**. **Revert to saved** abandons an experiment.

Unsaved edits also get a separate recovery draft after a short pause. Reloading
restores that draft without changing the saved checkpoint. **Autosave edits** is
optional; when enabled it updates the selected build automatically. **Recover…**
keeps the 20 most recent overwritten, discarded, or deleted versions per build
kind, and restores them as a separate copy.

Storage errors are shown explicitly. Browser storage is not a cloud backup:
clearing site data or changing browser/device does not carry builds with you.
Use **Export** for a portable backup or to share a build with friends.

## Importing your character

Multiplayer-friendly: it reads the client, not the world save.

1. Copy `kubejs/client_scripts/pob_export.js` into your instance's
   `kubejs/client_scripts/`.
2. Relaunch and join a world. It writes `pob_export.dat` and says so in chat.
3. Open the planner, click **Load character…**, and select `pob_export.dat`.
4. Name your build and click **Save now**.

Use the latest `pob_export.js`: it includes live attributes such as permanent
Heart Container health that ordinary saved attributes omit. After replacing an
older exporter, restart Minecraft, join your world, and load the fresh `.dat`.
**Config → Heart Containers** fills in the exported consumed count automatically.
You can also enter 0–100 for a manual build or an older export; each adds 2 health.

`kubejs/client_scripts/pob_dump_items.js` is optional and does the same thing
for item attributes, which live in each mod's Java rather than in any datapack.

## Building it yourself

The registry data under `out214/` was extracted from a Mine & Slash install
with the `extract*.py` and `export_*.py` scripts. To regenerate it against your
own copy of the pack, run those against your instance; then:

```
python export_build.py --save testsaves/pob_export.dat
python build_ui.py                 # writes docs/index.html
node smoke.js docs/index.html      # loads the page and fails on any error
node test_damage.js                # damage routing and mitigation cases
node test_resources.js             # final-stat conversion cases
node test_effect_strength.js       # tagged buff strength and aura separation
python test_infusions.py           # rarity-based infusion rolls
python test_core_scaling.py        # level scaling of rolled attributes
node test_import_effects.js docs/index.html # secondary buffs, codex and socket families
python test_resources.py           # the same cases in the Python resolver
node test_exporter.js              # client exporter capture/change detection
node test_builds.js docs/index.html # saved builds and browser interactions
node test_share_url.js             # sharing a build as a link
node test_quality.js               # gear quality against the game's arithmetic
node test_resist_display.js        # resistances shown against their cap
node score_browser.js              # the browser vs a real .dat, loaded as a player does
python test_references.py          # nothing shipped points at a dropped skill
```

## Found something wrong?

Click **Report a problem** in the top-left. It assembles what is actually
needed - which tab and skill, what buffs were on, the target, and your build
code so the exact build can be loaded - and copies it for you to paste into an
[issue](https://github.com/Setsuni/craft-to-exile-2-pob/issues/new/choose).

Two things make a report land immediately:

- **For a number that looks wrong**, screenshot the in-game **Damage Breakdown
  -> Last Hit** panel. It itemises every multiplier the game applied, which is
  usually enough to find the single term that disagrees. A dummy parse helps
  too - say how long the window was and which buffs were up, because an
  unbuffed model compared against a buffed parse looks broken and is not.
- **For wrong item, skill or tree data**, an in-game tooltip screenshot is
  almost always enough on its own.

When a character has been imported, the report includes differences against
that character's saved in-game stats to help reproduce the problem.

## Accuracy

The stat sheet is reconciled against the values the game reports; the damage
model has been compared with timed parses on a training dummy. Calculations
are approximate and may differ from the game. Treat the damage numbers as a
guide to *relative* choices — which
node, which item — before treating them as absolute.

## Credits

Mine & Slash is by robertx22; Craft to Exile 2 is by the CTE team. This is an
unofficial fan tool and ships no mod code — the data under `out214/` is
extracted from a local install for interoperability.
