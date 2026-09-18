// CTE2 PoB - character exporter (CLIENT side, works on servers).
//
// The planner needs your build. On a server you never see your own
// playerdata/<uuid>.dat, so this reads the copy the client already has.
//
// It is complete enough: PlayerData.buildClientNBT() calls writeCommon(), which
// writes tals (talents), asc (school order + allocated_lvls), casting (spell
// loadout), stats, points, gems, jewels and auras. Only character-slot items
// and the unique collection are server-only, and neither feeds the stat sheet.
// Equipped gear is not in that capability at all - it rides on the inventory
// item stacks as mmorpg_gear NBT, which the client obviously has.
//
// Output is gzipped NBT shaped like a real player .dat (ForgeCaps + Inventory
// + Attributes), because NBTIO.write() calls NbtIo.writeCompressed. So
// read_character.py consumes it with no new parsing at all.
//
// There is NO command and NO chat trigger, on purpose: KubeJS client scripts
// get only ClientEvents.init / lang / tick, and the ForgeEvents binding that
// would catch a typed sentinel is registered for startup scripts only
// (BuiltinKubeJSForgePlugin gates it on ScriptType.isStartup). So this just
// watches, and rewrites the file whenever your build actually changes.
//
// Install : copy to <pack>/kubejs/client_scripts/
// Use     : /reload, or relaunch. Play. The file keeps itself current.
// Output  : <pack>/kubejs/pob_export.dat

const Minecraft = Java.loadClass('net.minecraft.client.Minecraft')
const CompoundTag = Java.loadClass('net.minecraft.nbt.CompoundTag')
const ListTag = Java.loadClass('net.minecraft.nbt.ListTag')
// java.nio.file.Paths is blocked by KubeJS's class filter, so the output path
// has to come from somewhere allowed. Two routes, tried in order: KubeJS
// registers a type wrapper for Path, so a plain string may coerce on its own;
// failing that, KubeJSPaths.DIRECTORY is the kubejs/ folder as a real Path.
let KubeJSPaths = null
try {
    KubeJSPaths = Java.loadClass('dev.latvian.mods.kubejs.KubeJSPaths')
} catch (err) {
    console.warn('[pob] KubeJSPaths unavailable: ' + err)
}
const Load = Java.loadClass('com.robertx22.mine_and_slash.uncommon.datasaving.Load')
const POB_ATTR_REG = Java.loadClass('net.minecraftforge.registries.ForgeRegistries').ATTRIBUTES
let POB_VESSELS = null
try { POB_VESSELS = Java.loadClass('tictim.paraglider.api.vessel.VesselContainer') }
catch (err) { console.warn('[pob] Heart Container count unavailable: ' + err) }

const OUT = 'kubejs/pob_export.dat'
const OUT_NAME = 'pob_export.dat'
const EVERY = 60          // ticks between checks - 3s, cheap enough to not notice

let ticks = 0
let lastSig = null        // what we last wrote, so an unchanged build costs nothing
let announced = false     // greet once per session, not once per write
let broken = false        // stop retrying if the capability is unreachable

function say(msg, colour) {
    try {
        Minecraft.getInstance().player.displayClientMessage(
            colour === 'red' ? Text.red(msg)
                : colour === 'yellow' ? Text.yellow(msg)
                    : Text.green(msg), false)
    } catch (err) { /* no player yet */ }
    console.info('[pob] ' + msg)
}

// The two Mine & Slash capabilities, plus whatever the entity itself carries.
// Returns null if the client cannot reach Mine & Slash at all.
function buildRoot(p) {
    const root = new CompoundTag()

    // Entity.saveWithoutId writes Inventory, Attributes AND ForgeCaps in one
    // go - ForgeCaps is where curios live, which a hand-built Inventory would
    // miss. If it throws client-side, fall back to the two pieces
    // read_character.py actually requires.
    try {
        p.saveWithoutId(root)
    } catch (err) {
        console.warn('[pob] saveWithoutId failed, falling back: ' + err)
        try { root.put('Inventory', p.getInventory().save(new ListTag())) } catch (e) {
            console.warn('[pob] inventory: ' + e)
        }
        try { root.put('Attributes', p.getAttributes().save()) } catch (e) {
            console.warn('[pob] attributes: ' + e)
        }
    }

    // Force the Mine & Slash caps in explicitly - authoritative regardless of
    // what saveWithoutId put in ForgeCaps.
    let caps = root.getCompound('ForgeCaps')
    if (!caps) caps = new CompoundTag()
    let got = false

    try {
        // buildClientNBT, not serializeNBT: the full serialize also writes
        // character items and the unique collection, which the client does not
        // have, and asking for them can throw.
        caps.put('mmorpg:player_data', Load.player(p).buildClientNBT())
        got = true
    } catch (err) {
        console.warn('[pob] player_data via buildClientNBT failed: ' + err)
        try {
            caps.put('mmorpg:player_data', Load.player(p).serializeNBT())
            got = true
        } catch (e) { console.warn('[pob] player_data via serializeNBT failed: ' + e) }
    }
    try {
        caps.put('mmorpg:entity_data', Load.Unit(p).serializeNBT())
        got = true
    } catch (err) {
        console.warn('[pob] entity_data failed: ' + err)
    }

    root.put('ForgeCaps', caps)
    if (POB_VESSELS) {
        try { root.putInt('PobHeartContainers', POB_VESSELS.get(p).heartContainer()) }
        catch (err) { console.warn('[pob] Could not read Heart Container count: ' + err) }
    }
    // Attributes.save() omits transient modifiers, including consumed Heart
    // Containers. Capture the effective client values separately from bases.
    var pobLiveAttributes = new CompoundTag()
    // Keep max health available even if this KubeJS build cannot enumerate
    // AttributeMap. Use var here: Rhino rejects the block-scoped declaration.
    try { pobLiveAttributes.putDouble('minecraft:generic.max_health', p.getMaxHealth()) }
    catch (err) { console.warn('[pob] Live max health unavailable: ' + err) }
    try {
        p.getAttributes().getSyncableAttributes().forEach(attr => {
            var pobAttributeId = POB_ATTR_REG.getKey(attr.getAttribute())
            if (pobAttributeId) pobLiveAttributes.putDouble(String(pobAttributeId), attr.getValue())
        })
    } catch (err) {
        console.warn('[pob] Runtime attributes unavailable: ' + err)
    }
    root.put('PobRuntimeAttributes', pobLiveAttributes)
    root.putInt('PobExportVersion', 2)
    return got ? root : null
}

// Write the tag, trying each allowed path route until one takes.
function writeTag(root) {
    try {
        NBTIO.write(OUT, root)                       // string, via the type wrapper
        return true
    } catch (err) {
        console.warn('[pob] string path rejected: ' + err)
    }
    if (KubeJSPaths) {
        try {
            NBTIO.write(KubeJSPaths.DIRECTORY.resolve(OUT_NAME), root)
            return true
        } catch (err) {
            console.warn('[pob] KubeJSPaths route failed: ' + err)
        }
    }
    say('Could not write ' + OUT + ' - no usable path route. See the log.', 'red')
    return false
}

ClientEvents.tick(event => {
    if (broken) return
    if (++ticks % EVERY !== 0) return

    const p = Minecraft.getInstance().player
    if (!p) return

    let root
    try {
        root = buildRoot(p)
    } catch (err) {
        broken = true
        say('Exporter failed hard, giving up for this session: ' + err, 'red')
        return
    }
    if (!root) {
        broken = true
        say('Could not read Mine & Slash data off the client - see the log. ' +
            'The planner will need a different route.', 'red')
        return
    }

    // toString is SNBT: good enough as a change signature, and it means an
    // idle session writes to disk exactly never.
    let sig
    try {
        sig = String(root.getCompound('ForgeCaps')) + '|' + String(root.get('Inventory')) +
            '|' + String(root.get('Attributes')) + '|' + String(root.get('PobRuntimeAttributes')) +
            '|' + String(root.get('PobHeartContainers'))
    } catch (err) {
        sig = String(ticks)          // no signature, fall back to always writing
    }
    if (sig === lastSig) return

    if (!writeTag(root)) { broken = true; return }

    lastSig = sig
    if (!announced) {
        announced = true
        say('Build exported to ' + OUT + '. It updates itself as you play.', 'green')
    } else {
        console.info('[pob] build changed, rewrote ' + OUT)
    }
})
