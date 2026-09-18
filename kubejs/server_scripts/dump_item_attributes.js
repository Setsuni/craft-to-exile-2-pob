// CTE2 PoB - gear dump.
//
// Mine & Slash converts vanilla item ATTRIBUTES into RPG stats via
// mmorpg_stat_compat (generic.attack_damage -> total_damage at 0.5x,
// generic.armor / armor_toughness -> gear_defense at 0.1x, and so on).
//
// Those attributes live in each mod's Java, not in any datapack, so a
// calculator cannot read them from files. This dumps them from the running
// game instead.
//
// WIDER THAN IT USED TO BE. The old version kept only items that carry an
// attribute modifier, which quietly excluded every bow in the game: a bow's
// damage is in its shoot logic, not an attribute, so it has none. That is why
// the Twilight Forest seeker bow never appeared. Anything gear-shaped is now
// recorded - if it has durability it can be worn or wielded, and the planner
// needs to be able to name it even when its attribute list is empty.
//
// Install : copy to <pack>/kubejs/server_scripts/
// Run     : /reload, then in console  /kubejs_dump_item_attributes
// Output  : <pack>/kubejs/item_attributes.json
//
// Safe to leave installed - it only runs when the command is called.

const ATTR_REG = Java.loadClass('net.minecraftforge.registries.ForgeRegistries').ATTRIBUTES

ServerEvents.commandRegistry(event => {
    const { commands: Commands } = event

    event.register(
        Commands.literal('kubejs_dump_item_attributes')
            .requires(src => src.hasPermission(2))
            .executes(ctx => {
                const out = {}
                let withAttrs = 0
                let gearNoAttrs = 0
                let scanned = 0

                Item.getList().forEach(stack => {
                    scanned++
                    const id = stack.getId()
                    if (out[id]) return

                    const entry = {}
                    // Every slot matters: a weapon's damage rides on MAINHAND,
                    // armour's on its own slot, curios report on MAINHAND too.
                    const slots = ['mainhand', 'offhand', 'head', 'chest', 'legs', 'feet']
                    slots.forEach(slotName => {
                        let mods
                        try {
                            mods = stack.getAttributeModifiers(slotName)
                        } catch (err) {
                            return
                        }
                        if (!mods) return
                        mods.entries().forEach(e => {
                            // Attribute has no getRegistryName() in 1.20.1 - going
                            // through toString() yields a useless object identity
                            // like RangedAttribute@1ec33102. Ask the registry.
                            let attrId = String(ATTR_REG.getKey(e.getKey()))
                            const mod = e.getValue()
                            const amount = mod.getAmount()
                            if (!amount) return
                            if (!entry[slotName]) entry[slotName] = {}
                            // operation: 0 add, 1 multiply_base, 2 multiply_total
                            entry[slotName][attrId] = {
                                amount: amount,
                                op: mod.getOperation().toString()
                            }
                        })
                    })

                    const hasAttrs = Object.keys(entry).length > 0

                    // Gear-shaped: durability means it is worn or wielded rather
                    // than stacked in a chest. This is what brings bows, fishing
                    // rods and the like into the dump at all.
                    let durability = 0
                    try { durability = stack.getMaxDamage() } catch (err) { durability = 0 }
                    const isGear = durability > 0

                    if (!hasAttrs && !isGear) return

                    let name = id
                    try { name = String(stack.getName().getString()) } catch (err) { }

                    out[id] = {
                        name: name,
                        durability: durability,
                        // Present but empty for a bow: real, and worth saying so
                        // rather than omitting the item entirely.
                        attrs: entry
                    }
                    if (hasAttrs) withAttrs++; else gearNoAttrs++
                })

                // JsonIO.write does NOT create parent directories - writing to a
                // missing kubejs/exported/ throws NoSuchFileException. Write to
                // kubejs/ itself, which always exists.
                JsonIO.write('kubejs/item_attributes.json', out)
                ctx.getSource().sendSuccess(
                    Text.green(
                        'Dumped ' + (withAttrs + gearNoAttrs) + ' items (' +
                        withAttrs + ' with attributes, ' + gearNoAttrs +
                        ' gear without) of ' + scanned +
                        ' scanned to kubejs/item_attributes.json'
                    ),
                    false
                )
                return 1
            })
    )
})
