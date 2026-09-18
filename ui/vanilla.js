/* ---- vanilla and modded gear -------------------------------------------
   Mine & Slash does not ignore a Botania chestplate. `mmorpg_stat_compat`
   converts vanilla item ATTRIBUTES into sheet stats, which is why crafting on
   Terrasteel or a Twilight Forest base is not cosmetic.

   StatCompat.getResult reads LivingEntity.getAttributeValue - the ENTITY total
   across everything worn - and converts once:

       int v = (int)(total * conversion);
       v = clamp(v, minimum_cap, maximum_cap);
       if (v != 0) v = (int) scaling.scale(v, level);

   Converting per item and summing is NOT equivalent, and the difference is not
   academic: a Terrasteel chestplate is 8 armour, 8 * 0.1 = 0.8, which truncates
   to ZERO on its own. The full set is 20 armour, which converts to 2. So a
   per-item number would tell you Terrasteel does nothing, which is wrong.

   Hence the basket: tick the pieces you would wear, and the panel pools the
   attributes first and converts once, the way the game does.

   Attributes with no conversion rule - knockback resistance, attack speed - are
   marked: they still work in game, they just never reach the MnS sheet. */
const VAN = __VANILLA__;

/* The browse-and-tick "Vanilla gear" tab that used to live here is gone. It
   existed to pool attributes across a hypothetical set before the Items tab
   could do it; each slot now picks its own base and the sheet pools the whole
   set exactly the same way, so the tab was a second, worse answer to a
   question already answered in the place you were asking it.

   The DATA stays - ui/items.js reads VAN for the per-slot base picker. */
