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

## Importing your character

Multiplayer-friendly: it reads the client, not the world save.

1. Copy `kubejs/client_scripts/pob_export.js` into your instance's
   `kubejs/client_scripts/`.
2. Relaunch and join a world. It writes `pob_export.dat` and says so in chat.
3. `python export_build.py --save <path to pob_export.dat>`
4. `python build_ui.py`

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
```

`NOTES.md` is the working record: the game mechanics as read out of the
bytecode, what has been validated against a real damage parse, and what is
still wrong. `NEXT_STEPS.md` is the queue - what is known to be broken, what is
missing, and in what order it is worth fixing.

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

The planner already knows it gets some stats wrong; the report includes that
list, so you can see whether what you found is new.

## Accuracy

The stat sheet is reconciled against the values the game reports; the damage
model is reconciled against a timed parse on a training dummy. Both are close
rather than exact, and `NOTES.md` says where the gaps are rather than hiding
them. Treat the damage numbers as a good guide to *relative* choices — which
node, which item — before treating them as absolute.

## Credits

Mine & Slash is by robertx22; Craft to Exile 2 is by the CTE team. This is an
unofficial fan tool and ships no mod code — the data under `out214/` is
extracted from a local install for interoperability.
