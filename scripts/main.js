import {
    world,
    system,
    ItemStack
} from "@minecraft/server";

// Sky Gift から引き継ぐ設定
const CHECK_INTERVAL = 5;
const SEARCH_RADIUS = 40;
const SEARCH_RADIUS_SQ = SEARCH_RADIUS * SEARCH_RADIUS;

const MAX_CUBES = 10;
const CUBE_LIFETIME = 12000;

// めっちゃサルファーキューブ用
const CUBE_TYPE = "minecraft:sulfur_cube";
const CUBE_TAG = "msc_cube";
const CUBE_TIME_PREFIX = "msc_cube_time_";

// デバッグ表示
const DEBUG_MODE = false;

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

const lastChunk = new Map();
let spawnSequence = 0;


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
            {
                x: surface.x + 0.5,
                y: surface.y + 1,
                z: surface.z + 0.5
            },
            selectedBlockId,
            currentTick
        );

        debugSpawnResult(
            player,
            surfaceBlockId,
            surface.x,
            surface.y,
            surface.z,
            spawned,
            spawned
                ? `変身先: ${selectedBlockId}`
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


// プレイヤーの高さから空気との界面を探す。
// 開始地点がAirなら下へ、非Airなら上へ探索する。
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

    // 開始地点がAirなら下方向へ探索
    if (isAirBlock(initialBlock)) {
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

            if (!isAirBlock(block)) {
                return { block, x, y, z };
            }
        }
    }

    // 開始地点が非Airなら上方向へ探索
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

            if (isAirBlock(block)) {
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


// 中心ブロックはスポーン判定を通過したブロック。
// 周囲4ブロックは同じY座標で検索する。
function findTransformCandidates(
    dimension,
    x,
    y,
    z,
    centerBlock
) {
    const offsets = [
        { x: 0, z: 0 },
        { x: 1, z: 0 },
        { x: -1, z: 0 },
        { x: 0, z: 1 },
        { x: 0, z: -1 }
    ];

    const candidates = [];

    for (const offset of offsets) {
        let block;

        if (offset.x === 0 && offset.z === 0) {
            block = centerBlock;
        } else {
            try {
                block = dimension.getBlock({
                    x: x + offset.x,
                    y,
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
function spawnCube(dimension, location, blockId, currentTick) {
    let cube;

    try {
        cube = dimension.spawnEntity(CUBE_TYPE, location);

        cube.addTag(CUBE_TAG);
        cube.addTag(`${CUBE_TIME_PREFIX}${currentTick}`);

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
}, 600);


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


// 報酬を出してサルファーキューブを削除
function openCube(cube) {
    try {
        cube.dimension.spawnItem(
            new ItemStack("minecraft:emerald", 1),
            cube.location
        );
    } catch {}

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