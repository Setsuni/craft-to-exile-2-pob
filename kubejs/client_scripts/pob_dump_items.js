// CTE2 PoB - gear dump (CLIENT side, works on servers).
//
// Mine & Slash converts vanilla item ATTRIBUTES into RPG stats via
// mmorpg_stat_compat (generic.attack_damage -> total_damage at 0.5x,
// generic.armor / armor_toughness -> gear_defense at 0.1x, and so on). Those
// attributes live in each mod's Java rather than in any datapack, so they have
// to be read out of a running game.
//
// This is the CLIENT half. The server-script version registers a command, which
// is useless on a multiplayer server that does not run KubeJS - the command
// simply does not exist there, which is the "unknown or incomplete command"
// you get. The item registry is fully present on the client, so the dump works
// perfectly well from here; it just cannot be triggered by a command, because
// KubeJS client scripts get no command registration.
//
// So it writes itself once, shortly after you are in a world, and then stops.
//
// WIDER THAN THE OLD VERSION. That one kept only items carrying an attribute
// modifier, which quietly excluded every bow in the game: a bow's damage is in
// its shoot logic, not an attribute. That is why the Twilight Forest seeker bow
// never appeared. Anything gear-shaped is recorded now - if it has durability
// it is worn or wielded - even when its attribute list comes back empty.
//
// Install : copy to <pack>/kubejs/client_scripts/
// Use     : relaunch the client. It writes once and says so in chat.
// Output  : <pack>/kubejs/item_attributes.json

// SCOPE: KubeJS runs every client script in ONE shared scope, so a top-level
// `const` here collides with the same name in any other script in this folder.
// This file and pob_export.js both declared `Minecraft`, `OUT`, `ticks` and
// `say`; the collision threw "redeclaration of const OUT" at load and killed
// pob_export.js entirely - the exporter silently stopped writing for two days.
// Everything below is therefore wrapped in an IIFE and shares nothing.
(function () {
const Minecraft = Java.loadClass('net.minecraft.client.Minecraft')
const ATTR_REG = Java.loadClass('net.minecraftforge.registries.ForgeRegistries').ATTRIBUTES

const OUT = 'kubejs/item_attributes.json'
const SLOTS = ['mainhand', 'offhand', 'head', 'chest', 'legs', 'feet']

let ticks = 0
let done = false

function say(msg, colour) {
    try {
        Minecraft.getInstance().player.displayClientMessage(
            colour === 'red' ? Text.red(msg) : Text.green(msg), false)
    } catch (err) { /* no player yet */ }
    console.info('[pob] ' + msg)
}

function dump() {
    const out = {}
    let withAttrs = 0, gearOnly = 0, scanned = 0

    Item.getList().forEach(stack => {
        scanned++
        const id = stack.getId()
        if (out[id]) return

        const attrs = {}
        SLOTS.forEach(slot => {
            let mods
            try { mods = stack.getAttributeModifiers(slot) } catch (err) { return }
            if (!mods) return
            mods.entries().forEach(e => {
                // Attribute has no getRegistryName() in 1.20.1 - toString gives
                // a useless object identity like RangedAttribute@1ec33102, so
                // the registry has to be asked for the key.
                const attrId = String(ATTR_REG.getKey(e.getKey()))
                const mod = e.getValue()
                const amount = mod.getAmount()
                if (!amount) return
                if (!attrs[slot]) attrs[slot] = {}
                // operation: 0 add, 1 multiply_base, 2 multiply_total
                attrs[slot][attrId] = {
                    amount: amount,
                    op: String(mod.getOperation())
                }
            })
        })

        const hasAttrs = Object.keys(attrs).length > 0

        // Durability is the test for "this is worn or wielded" rather than
        // stacked in a chest, and it is what finally brings bows in.
        let durability = 0
        try { durability = stack.getMaxDamage() } catch (err) { durability = 0 }
        if (!hasAttrs && durability <= 0) return

        let name = id
        try { name = String(stack.getName().getString()) } catch (err) { }

        out[id] = { name: name, durability: durability, attrs: attrs }
        if (hasAttrs) withAttrs++; else gearOnly++
    })

    try {
        JsonIO.write(OUT, out)
    } catch (err) {
        say('Could not write ' + OUT + ': ' + err, 'red')
        return false
    }
    say('Dumped ' + (withAttrs + gearOnly) + ' items to ' + OUT + ' (' +
        withAttrs + ' with attributes, ' + gearOnly + ' gear without, ' +
        scanned + ' scanned).')
    return true
}

ClientEvents.tick(event => {
    if (done) return
    /* Wait until the client is actually in a world: the registry is populated
       by then, and there is a player to report to. */
    if (++ticks < 100) return
    if (!Minecraft.getInstance().player) return
    done = true
    try {
        dump()
    } catch (err) {
        say('Item dump failed: ' + err, 'red')
    }
})
})()
