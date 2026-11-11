import {
    world,
    system,
    ItemStack
} from "@minecraft/server";

// デバッグ表示
const DEBUG_MODE = false;

// Sky Gift から引き継ぐ設定
const CHECK_INTERVAL = 5;
const SEARCH_RADIUS = 40;
const SEARCH_RADIUS_SQ = SEARCH_RADIUS * SEARCH_RADIUS;
const MIN_SPAWN_DISTANCE = SEARCH_RADIUS / 2;
const MIN_SPAWN_DISTANCE_SQ =
    MIN_SPAWN_DISTANCE * MIN_SPAWN_DISTANCE;

const MAX_CUBES = 10;
const CUBE_LIFETIME = 12000;

// めっちゃサルファーキューブ用
const CUBE_TYPE = "minecraft:sulfur_cube";
const CUBE_TAG = "msc_cube";
const CUBE_TIME_PREFIX = "msc_cube_time_";
const FLUTE_INTERVAL = 600; // 30秒
// 発見難易度Tierのタグ
const TIER_TAG_PREFIX = "msc_tier_";

// Tierごとの報酬
// 将来、Tierごとにアイテムや個数を変更できるよう明示的に定義
const TIER_REWARDS = {
    "msc_tier_1": {
        itemId: "minecraft:emerald",
        amount: 1
    },
    "msc_tier_2": {
        itemId: "minecraft:emerald",
        amount: 2
    },
    "msc_tier_3": {
        itemId: "minecraft:emerald",
        amount: 3
    },
    "msc_tier_4": {
        itemId: "minecraft:emerald",
        amount: 4
    },
    "msc_tier_5": {
        itemId: "minecraft:emerald",
        amount: 5
    }
};

// バニラがサルファーキューブの吸収対象として定義しているアイテムタグ
const SULFUR_CUBE_ARCHETYPE_TAGS = [
    "minecraft:sulfur_cube_archetype_bouncy",
    "minecraft:sulfur_cube_archetype_regular",
    "minecraft:sulfur_cube_archetype_slow_bouncy",
    "minecraft:sulfur_cube_archetype_slow_flat",
    "minecraft:sulfur_cube_archetype_fast_flat",
    "minecraft:sulfur_cube_archetype_light",
    "minecraft:sulfur_cube_archetype_fast_sliding",
    "minecraft:sulfur_cube_archetype_slow_sliding",
    "minecraft:sulfur_cube_archetype_sticky",
    "minecraft:sulfur_cube_archetype_high_resistance",
    "minecraft:sulfur_cube_archetype_explosive",
    "minecraft:sulfur_cube_archetype_hot"
];

// スポーン位置として許可するブロック
const SPAWNABLE_BLOCK_IDS = new Set([
    "minecraft:deadbush", // 枯れ木
    "minecraft:bush", // 茂み
    "minecraft:firefly_bush", // ホタルの茂み
    "minecraft:red_shrub", // 赤色の低木
    "minecraft:vine", // ツタ
    "minecraft:cave_vines", // 洞窟のツタ
    "minecraft:cave_vines_body_with_berries", // 洞窟のツタのツル（実付き・胴体）
    "minecraft:cave_vines_head_with_berries", // 洞窟のツタのツル（実付き・先端）
    "minecraft:pale_hanging_moss", // 色褪せた垂れ苔

    "minecraft:dandelion", // タンポポ
    "minecraft:poppy", // ポピー
    "minecraft:blue_orchid", // ヒスイラン
    "minecraft:allium", // アリウム
    "minecraft:azure_bluet", // ヒナソウ
    "minecraft:red_tulip", // 赤色のチューリップ
    "minecraft:orange_tulip", // 橙色のチューリップ
    "minecraft:white_tulip", // 白色のチューリップ
    "minecraft:pink_tulip", // 桃色のチューリップ
    "minecraft:oxeye_daisy", // フランスギク
    "minecraft:cornflower", // ヤグルマギク
    "minecraft:lily_of_the_valley", // スズラン
    "minecraft:torchflower", // トーチフラワー
    "minecraft:open_eyeblossom", // 開いたヒトミソウ
    "minecraft:closed_eyeblossom", // 閉じたヒトミソウ
    "minecraft:spore_blossom", // 胞子の花
    "minecraft:cactus_flower", // サボテンの花
    "minecraft:pink_petals", // 桜色の花びら
    "minecraft:wildflowers", // 野花
    "minecraft:leaf_litter", // 落ち葉

    "minecraft:brown_mushroom", // 茶色のキノコ
    "minecraft:red_mushroom", // 赤色のキノコ
    "minecraft:glow_lichen", // ヒカリゴケ
    "minecraft:crimson_fungus", // 真紅のキノコ
    "minecraft:warped_fungus", // 歪んだキノコ
    "minecraft:weeping_vines", // しだれツタ
    "minecraft:twisting_vines", // ねじれツタ

    "minecraft:resin_clump", // 樹脂の塊
    "minecraft:reeds", // サトウキビ

    "minecraft:torch", // 松明（床・壁）
    "minecraft:soul_torch", // 魂の松明（床・壁）
    "minecraft:copper_torch", // 銅の松明（床・壁）

    "minecraft:rail", // レール
    "minecraft:golden_rail", // パワードレール
    "minecraft:detector_rail", // ディテクターレール
    "minecraft:activator_rail", // アクティベーターレール

    "minecraft:redstone_wire", // レッドストーンダスト
    "minecraft:redstone_torch" // レッドストーントーチ（床・壁）
]);

const lastChunk = new Map();
let spawnSequence = 0;
let nextFluteTick = system.currentTick + FLUTE_INTERVAL;
const clockDisplayPlayers = new Set();

// プレイヤーが現在いるディメンションを取得する
// ディメンションIDを固定列挙せず、動的に対応する
function getActiveDimensions(players = world.getPlayers()) {
    const dimensions = new Map();

    for (const player of players) {
        const dimension = player.dimension;
        dimensions.set(dimension.id, dimension);
    }

    return dimensions;
}


// 定期的なスポーン抽選
system.runInterval(() => {
    const players = world.getPlayers();
    const activeDimensions = getActiveDimensions(players);
    const currentTick = world.getAbsoluteTime();

    // プレイヤーがいる全ディメンションで寿命管理
    for (const dimension of activeDimensions.values()) {
        cleanupOldCubes(dimension, currentTick);
    }

    for (const player of players) {
        const dimension = player.dimension;
        const dimensionId = dimension.id;

        const chunkX = Math.floor(player.location.x / 16);
        const chunkZ = Math.floor(player.location.z / 16);

        const previousChunk = lastChunk.get(player.id);

        // プレイヤーが別ディメンションまたは別チャンクへ移動した時だけスポーン抽選
        if (
            previousChunk &&
            previousChunk.dimensionId === dimensionId &&
            previousChunk.x === chunkX &&
            previousChunk.z === chunkZ
        ) {
            continue;
        }

        lastChunk.set(player.id, {
            dimensionId,
            x: chunkX,
            z: chunkZ
        });

        if (cubeExistsNearby(dimension, player.location)) {
            continue;
        }

        // 半径40ブロックの円内からランダムに選ぶ
        const angle = Math.random() * Math.PI * 2;
        const distance = Math.sqrt(Math.random()) * SEARCH_RADIUS;

        const targetX = Math.floor(
            player.location.x + Math.cos(angle) * distance
        );

        const targetZ = Math.floor(
            player.location.z + Math.sin(angle) * distance
        );

        // プレイヤーの足元の高さから上下どちらかへ探索
        const surface = findSurfaceBlock(
            dimension,
            targetX,
            targetZ,
            Math.floor(player.location.y)
        );

        if (!surface) {
            debugSpawnResult(
                player,
                "不明",
                targetX,
                "不明",
                targetZ,
                false,
                "検索中にブロックを取得できなかった／界面が見つからなかった"
            );
            continue;
        }

// 実際のサルファーキューブ出現座標
const spawnLocation = {
    x: surface.x + 0.5,
    y: surface.y + 1,
    z: surface.z + 0.5
};

// いずれかのプレイヤーに近すぎる場合はスポーン失敗
if (isTooCloseToAnyPlayer(players, dimensionId, spawnLocation)) {
    debugSpawnResult(
        player,
        surface.block.typeId,
        surface.x,
        surface.y,
        surface.z,
        false,
        "プレイヤーに近すぎる"
    );
    continue;
}

        const surfaceBlockId = surface.block.typeId;

        // 最初に見つかったブロックが吸収可能でなければスポーン失敗
        if (!isTransformableBlock(surface.block)) {
            debugSpawnResult(
                player,
                surfaceBlockId,
                surface.x,
                surface.y,
                surface.z,
                false,
                "対象ブロック一覧に含まれていない"
            );
            continue;
        }

        // 真下・東西南北の計5ブロックから変身先候補を集める
const candidates = findTransformCandidates(
    dimension,
    surface.x,
    surface.y,
    surface.z,
    surface.block
);

        if (candidates.length === 0) {
            debugSpawnResult(
                player,
                surfaceBlockId,
                surface.x,
                surface.y,
                surface.z,
                false,
                "変身候補が見つからなかった"
            );
            continue;
        }

        const selectedBlockId =
            candidates[Math.floor(Math.random() * candidates.length)];

        const spawned = spawnCube(
            dimension,
           spawnLocation,
            selectedBlockId,
            currentTick,
    candidates.length
        );

        debugSpawnResult(
            player,
            surfaceBlockId,
            surface.x,
            surface.y,
            surface.z,
            spawned,
spawned
    ? `Tier: ${candidates.length} / 変身先: ${selectedBlockId}`
    : "エンティティ生成または装備処理に失敗"
                
        );
    }
}, CHECK_INTERVAL);


// スポーン検索結果をプレイヤーのチャットに表示
function debugSpawnResult(player, blockId, x, y, z, success, reason = "") {
    if (!DEBUG_MODE) {
        return;
    }

    const resultText = success ? "成功" : "失敗";
    const detail = reason ? ` / ${reason}` : "";

    player.sendMessage(
        `[めっちゃサルファーキューブ DEBUG] ブロック: ${blockId} / 座標: X=${x}, Y=${y}, Z=${z} / スポーン: ${resultText}${detail}`
    );
}


// プレイヤーの高さからスポーン可能空間との界面を探す。
// 空気または許可ブロックなら下へ、
// それ以外なら上へ探索する。
// ディメンションの高度範囲を超えた場合は失敗扱い。
function findSurfaceBlock(dimension, x, z, startY) {
    const minY = dimension.heightRange.min;
    const maxY = dimension.heightRange.max - 1;

    // 探索開始Yをディメンションの範囲内に収める
    const initialY = Math.max(
        minY,
        Math.min(maxY, startY)
    );

    let initialBlock;

    try {
        initialBlock = dimension.getBlock({
            x,
            y: initialY,
            z
        });
    } catch {
        return undefined;
    }

    if (!initialBlock) {
        return undefined;
    }

    // 開始地点がスポーン可能空間なら下方向へ探索
    if (isSpawnSpaceBlock(initialBlock)) {
        for (let y = initialY - 1; y >= minY; y--) {
            let block;

            try {
                block = dimension.getBlock({ x, y, z });
            } catch {
                return undefined;
            }

            if (!block) {
                return undefined;
            }

            // スポーン可能空間でないブロックを足場候補とする
            if (!isSpawnSpaceBlock(block)) {
                return { block, x, y, z };
            }
        }
    }

    // 開始地点がスポーン可能空間でなければ上方向へ探索
    else {
        for (let y = initialY + 1; y <= maxY; y++) {
            let block;

            try {
                block = dimension.getBlock({ x, y, z });
            } catch {
                return undefined;
            }

            if (!block) {
                return undefined;
            }

            // 最初にスポーン可能空間が見つかったら、
            // その直下を足場候補とする
            if (isSpawnSpaceBlock(block)) {
                const surfaceY = y - 1;

                let surfaceBlock;

                try {
                    surfaceBlock = dimension.getBlock({
                        x,
                        y: surfaceY,
                        z
                    });
                } catch {
                    return undefined;
                }

                if (!surfaceBlock) {
                    return undefined;
                }

                return {
                    block: surfaceBlock,
                    x,
                    y: surfaceY,
                    z
                };
            }
        }
    }

    // ディメンションの上下限まで探索しても界面がなかった
    return undefined;
}

// Air判定
function isAirBlock(block) {
    return (
        block.typeId === "minecraft:air" ||
        block.typeId === "minecraft:cave_air" ||
        block.typeId === "minecraft:void_air"
    );
}

// 空気または許可リストに含まれるブロックか判定
function isSpawnSpaceBlock(block) {
    return (
        isAirBlock(block) ||
        SPAWNABLE_BLOCK_IDS.has(block.typeId)
    );
}

// バニラのサルファーキューブ用アイテムタグを利用して吸収可能か判定
function isTransformableBlock(block) {
    try {
        const item = new ItemStack(block.typeId, 1);

        return SULFUR_CUBE_ARCHETYPE_TAGS.some((tag) =>
            item.hasTag(tag)
        );
    } catch {
        return false;
    }
}


function findTransformCandidates(
    dimension,
    x,
    y,
    z,
    centerBlock
) {
    // 中央は地面、周囲４か所は１ブロック上を調べる
    const offsets = [
        { x: 0, y: 0, z: 0 },
        { x: 1, y: 1, z: 0 },
        { x: -1, y: 1, z: 0 },
        { x: 0, y: 1, z: 1 },
        { x: 0, y: 1, z: -1 }
    ];

    const candidates = [];

    for (const offset of offsets) {
        let block;

        if (offset.x === 0 && offset.z === 0) {
            // 中央だけは地面ブロックをそのまま使う
            block = centerBlock;
        } else {
            try {
                block = dimension.getBlock({
                    x: x + offset.x,
                    y: y + offset.y,
                    z: z + offset.z
                });
            } catch {
                continue;
            }
        }

        if (!block || !isTransformableBlock(block)) {
            continue;
        }

        candidates.push(block.typeId);
    }

    return candidates;
}


// サルファーキューブを生成し、選んだブロックを持たせる
function spawnCube(dimension, location, blockId, currentTick, tier) {
    let cube;

    try {
        cube = dimension.spawnEntity(CUBE_TYPE, location);

        cube.addTag(CUBE_TAG);
        cube.addTag(`${CUBE_TIME_PREFIX}${currentTick}`);
        cube.addTag(`${TIER_TAG_PREFIX}${tier}`);

        // 生成個体を一時タグで指定
        const pendingTag = `msc_pending_${spawnSequence++}`;
        cube.addTag(pendingTag);

        dimension.runCommand(
            `replaceitem entity @e[type=${CUBE_TYPE},tag=${pendingTag}] slot.weapon.mainhand 0 ${blockId} 1`
        );

        // 恒久的な透明化
        dimension.runCommand(
            `effect @e[type=${CUBE_TYPE},tag=${pendingTag}] invisibility infinite 0 true`
        );

        cube.removeTag(pendingTag);
    } catch (error) {
        if (cube) {
            try {
                cube.remove();
            } catch {}
        }

        return false;
    }

    // 同時存在数の上限を超えた場合、最も古い個体を削除
    const cubes = [
        ...dimension.getEntities({
            type: CUBE_TYPE,
            tags: [CUBE_TAG]
        })
    ];

    cubes.sort((a, b) => getCubeTime(a) - getCubeTime(b));

    while (cubes.length > MAX_CUBES) {
        const oldest = cubes.shift();

        try {
            oldest.remove();
        } catch {}
    }

    return true;
}


// 30秒ごとに、このアドオンが召喚した全サルファーキューブから笛を鳴らす。
// プレイヤーがいるディメンションを動的に取得する。
function playFluteForAddonCubes(volume, pitch) {
    const activeDimensions = getActiveDimensions();

    for (const dimension of activeDimensions.values()) {
        const cubes = dimension.getEntities({
            type: CUBE_TYPE,
            tags: [CUBE_TAG]
        });

        for (const cube of cubes) {
            const { x, y, z } = cube.location;

            try {
                dimension.runCommand(
                    `playsound note.flute @a ${x} ${y} ${z} ${volume} ${pitch}`
                );
            } catch {
                // 個別の再生失敗で、ほかのキューブへの再生を止めない
            }
        }
    }
}


// 30秒ごとに5段階の笛を再生
system.runInterval(() => {
    // 次回の笛までの時間を更新
    nextFluteTick = system.currentTick + FLUTE_INTERVAL;

    playFluteForAddonCubes(3, 2.0);

    system.runTimeout(() => {
        playFluteForAddonCubes(2.5, 1.75);
    }, 5);

    system.runTimeout(() => {
        playFluteForAddonCubes(2, 1.5);
    }, 10);

    system.runTimeout(() => {
        playFluteForAddonCubes(1.5, 1.25);
    }, 15);

    system.runTimeout(() => {
        playFluteForAddonCubes(1, 1.0);
    }, 20);
}, FLUTE_INTERVAL);

// 右手に時計を持っているプレイヤーに、次の笛までの時間を表示
system.runInterval(() => {
    const players = world.getPlayers();

    for (const player of players) {
        let hasClock = false;

        try {
            const inventory = player.getComponent("minecraft:inventory");
            const heldItem = inventory?.container?.getItem(
                player.selectedSlotIndex
            );

            hasClock = heldItem?.typeId === "minecraft:clock";
        } catch {}

        if (hasClock) {
            const remainingSeconds = Math.max(
                0,
                Math.ceil((nextFluteTick - system.currentTick) / 20)
            );

            player.onScreenDisplay.setActionBar(
                `次の笛まで: ${remainingSeconds}秒`
            );

            clockDisplayPlayers.add(player.id);

        } else if (clockDisplayPlayers.has(player.id)) {
            // 時計を手放したら表示を消す
            player.onScreenDisplay.setActionBar("");
            clockDisplayPlayers.delete(player.id);
        }
    }

    // 切断済みプレイヤーのIDを整理
    const onlinePlayerIds = new Set(players.map(player => player.id));

    for (const playerId of clockDisplayPlayers) {
        if (!onlinePlayerIds.has(playerId)) {
            clockDisplayPlayers.delete(playerId);
        }
    }
}, 20);

// サルファーキューブを叩いたら報酬を出す
world.afterEvents.entityHitEntity.subscribe((event) => {
    const cube = event.hitEntity;

    if (!cube || cube.typeId !== CUBE_TYPE) {
        return;
    }

    if (!cube.hasTag(CUBE_TAG)) {
        return;
    }

    openCube(cube);
});



// キューブ発見時の爆発演出
function playCubeBurst(dimension, location, tier) {
    // 大きな爆発を中心に発生
    try {
        dimension.spawnParticle(
            "minecraft:huge_explosion_emitter",
            location
        );
    } catch {}

    // 緑・金色の粒子を周囲に散らす
for (let i = 0; i < tier * 3; i++) {
    const angle = Math.random() * Math.PI * 2;
    const radius = (0.4 + Math.random() * 0.9) * tier / 4;

    const particleLocation = {
        x: location.x + Math.cos(angle) * radius,
        y: location.y + Math.random() * 1.2 * tier / 4,
        z: location.z + Math.sin(angle) * radius
    };

    // 白いきらめきを追加
for (let i = 0; i < tier * 2; i++) {
    const angle = Math.random() * Math.PI * 2;
    const radius = (0.3 + Math.random() * 1.2) * tier / 4;

    const particleLocation = {
        x: location.x + Math.cos(angle) * radius,
        y: location.y + Math.random() * 1.5 * tier / 4,
        z: location.z + Math.sin(angle) * radius
    };

    // 花火の爆発音
    try {
        dimension.playSound(
            "firework.twinkle",
            location,
            {
                volume: 1.0,
                pitch: 1.0
            }
        );
    } catch {}
}

// 報酬を出してサルファーキューブを削除

function openCube(cube) {
    // 実際に付与されているTierタグをすべて確認
    const matchedTags = Object.keys(TIER_REWARDS).filter(
        tag => cube.hasTag(tag)
    );

    // 現在の仕様と同じく、最初に見つかったTierを採用
    const selectedTag = matchedTags.length > 0
        ? matchedTags[0]
        : "msc_tier_1";
const tier = Number(selectedTag.substring(TIER_TAG_PREFIX.length));
playCubeBurst(cube.dimension, { ...cube.location }, tier);
    const reward = TIER_REWARDS[selectedTag];

    // 調査用：実際のタグと選択された報酬を表示
    if (DEBUG_MODE) {
        world.sendMessage(
            `[MSC DEBUG] Tierタグ: ${matchedTags.length > 0 ? matchedTags.join(", ") : "なし"} / 採用: ${selectedTag} / 報酬: ${reward.amount}個`
        );
    }

try {
    const droppedItem = cube.dimension.spawnItem(
        new ItemStack(reward.itemId, reward.amount),
        cube.location
    );

    const itemComponent = droppedItem.getComponent("minecraft:item");

    if (DEBUG_MODE) {
        world.sendMessage(
            `[MSC DEBUG] 生成直後: ${itemComponent.itemStack.typeId} ${itemComponent.itemStack.amount}個`
        );
    }
} catch (error) {
    if (DEBUG_MODE) {
        world.sendMessage(
            `[MSC DEBUG] アイテム生成エラー: ${error}`
        );
    }
}

    try {
        cube.remove();
    } catch {}
}


// 寿命を迎えたサルファーキューブを削除
function cleanupOldCubes(dimension, currentTick) {
    const cubes = [
        ...dimension.getEntities({
            type: CUBE_TYPE,
            tags: [CUBE_TAG]
        })
    ];

    for (const cube of cubes) {
        const age = currentTick - getCubeTime(cube);

        if (age >= CUBE_LIFETIME) {
            try {
                cube.remove();
            } catch {}
        }
    }
}


// 同じディメンションにいるプレイヤーの近くならスポーンを拒否
function isTooCloseToAnyPlayer(players, dimensionId, location) {
    return players.some((player) => {
        if (player.dimension.id !== dimensionId) {
            return false;
        }

        const dx = player.location.x - location.x;
        const dy = player.location.y - location.y;
        const dz = player.location.z - location.z;

        const distanceSq =
            dx * dx + dy * dy + dz * dz;

        return distanceSq <= MIN_SPAWN_DISTANCE_SQ;
    });
}

// 近くに既存のサルファーキューブがいるか確認
function cubeExistsNearby(dimension, location) {
    const cubes = [
        ...dimension.getEntities({
            type: CUBE_TYPE,
            tags: [CUBE_TAG]
        })
    ];

    for (const cube of cubes) {
        const dx = cube.location.x - location.x;
        const dz = cube.location.z - location.z;

        const distanceSq = dx * dx + dz * dz;

        if (distanceSq <= SEARCH_RADIUS_SQ) {
            return true;
        }
    }

    return false;
}


// タグから生成Tickを取得
function getCubeTime(entity) {
    for (const tag of entity.getTags()) {
        if (tag.startsWith(CUBE_TIME_PREFIX)) {
            return Number(
                tag.substring(CUBE_TIME_PREFIX.length)
            );
        }
    }

    return 0;
}