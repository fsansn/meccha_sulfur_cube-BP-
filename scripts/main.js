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

// デバッグ表示（true の場合、スポーン候補地点の検索結果をチャットに表示）
const DEBUG_MODE = false;
// バニラがサルファーキューブの吸収対象として定義しているアイテムタグ。
// これらのタグに含まれるブロックだけを、変身可能なフルブロックとして扱う。
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

system.runInterval(() => {
    const overworld = world.getDimension("minecraft:overworld");
    const spawnY = overworld.heightRange.max - 1;
    const currentTick = world.getAbsoluteTime();

    cleanupOldCubes(overworld, currentTick);

    for (const player of world.getPlayers()) {
        if (player.dimension.id !== "minecraft:overworld") {
            continue;
        }
        const chunkX = Math.floor(player.location.x / 16);
        const chunkZ = Math.floor(player.location.z / 16);

        const previousChunk = lastChunk.get(player.id);

        // プレイヤーが別チャンクへ移動した時だけスポーン抽選
        if (
            previousChunk &&
            previousChunk.x === chunkX &&
            previousChunk.z === chunkZ
        ) {
            continue;
        }

        lastChunk.set(player.id, {
            x: chunkX,
            z: chunkZ
        });
        if (cubeExistsNearby(overworld, player.location)) {
            continue;
        }

        // Sky Gift と同じ、半径40ブロックの円内からランダムに選ぶ
        const angle = Math.random() * Math.PI * 2;
        const distance = Math.sqrt(Math.random()) * SEARCH_RADIUS;

        const targetX = Math.floor(
            player.location.x + Math.cos(angle) * distance
        );
        const targetZ = Math.floor(
            player.location.z + Math.sin(angle) * distance
        );
        // 上空から下へ検索し、最初に見つかった非Airブロックだけを判定
        const surface = findSurfaceBlock(
            overworld,
            targetX,
            targetZ,
            spawnY
        );

        if (!surface) {
            debugSpawnResult(
                player,
                targetX,
                "不明",
                targetZ,
                false,
                "検索中にブロックを取得できなかった／地面が見つからなかった"
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
            overworld,
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
            overworld,
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
            spawned ? `変身先: ${selectedBlockId}` : "エンティティ生成または装備処理に失敗"
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


// 上空から最初の非Airブロックを探す。
// チャンク未ロードなどで取得できない場合は、その地点の検索を失敗扱いにする。
function findSurfaceBlock(dimension, x, z, startY) {
    const minY = dimension.heightRange.min;

    for (let y = startY; y >= minY; y--) {
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
            continue;
        }

        return { block, x, y, z };
    }

    return undefined;
}

function isAirBlock(block) {
    return (
        block.typeId === "minecraft:air" ||
        block.typeId === "minecraft:cave_air" ||
        block.typeId === "minecraft:void_air"
    );
}


// バニラのサルファーキューブ用アイテムタグを利用して吸収可能か判定。
// タグの対象はサルファーキューブが実際に吸収できるブロック群。
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

// 中心ブロックは、スポーン判定を通過したブロック。
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

        // サルファーキューブの装備処理は、まず生成個体を対象にコマンドで試す。
        const pendingTag = `msc_pending_${spawnSequence++}`;
        cube.addTag(pendingTag);
        dimension.runCommand(
            `replaceitem entity @e[type=${CUBE_TYPE},tag=${pendingTag}] slot.weapon.mainhand 0 ${blockId} 1`
        );
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
function playFluteForAddonCubes(volume,pitch) {
    const overworld = world.getDimension("minecraft:overworld");
    const cubes = overworld.getEntities({
        type: CUBE_TYPE,
        tags: [CUBE_TAG]
    });

    for (const cube of cubes) {
        const { x, y, z } = cube.location;
        try {
            overworld.runCommand(
                `playsound note.flute @a ${x} ${y} ${z} ${volume} ${pitch}`
            );
        } catch {
            // 個別の再生失敗で、ほかのキューブへの再生を止めない
        }
    }
}

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
