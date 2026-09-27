"""Forest only where trees stand: the h1 class band corrected from the surface model.

Every array here is invented: a flat terrain at 10 m, a surface raised where a test
puts trees or roofs, and a class raster that is all forest unless a test says otherwise.
"""

from types import SimpleNamespace

import numpy as np
import pytest
from shapely.geometry import box

from commons_world import classes, grid, mapsteps
from commons_world.classes import (BUILDING, BOG, FARMLAND, FOREST, LAKE, OPEN, ROAD, SEA,
                                   forest_correction)
from commons_world.grid import Level
from commons_world.n50 import Area
from commons_world.raster import LevelGrid
from commons_world.terrain import ChunkSet

GROUND = 10.0
TALL = GROUND + 15.0


def world(shape=(80, 80), code=FOREST):
    """(classes, dtm, dom): all `code`, flat ground, no trees."""
    cls = np.full(shape, code, dtype=np.uint8)
    dtm = np.full(shape, GROUND)
    return cls, dtm, dtm.copy()


def stand_with_hole(size, shape=(80, 80), at=(30, 30)):
    """A closed canopy with one square treeless hole of `size` x `size` cells."""
    cls, dtm, dom = world(shape)
    dom[:] = TALL
    r, q = at
    dom[r:r + size, q:q + size] = GROUND
    return cls, dtm, dom


def test_the_constants_are_the_documented_ones():
    assert classes.CANOPY_MIN_M == 3.0 and classes.CANOPY_FRINGE_M == 2.0
    assert classes.MIN_OPEN_M2 == 25.0 and classes.SURFACE_GAP_M == 1.0


def test_a_clearing_opens_except_for_the_fringe_by_its_trees():
    cls, dtm, dom = stand_with_hole(20)
    opened, stats = forest_correction(cls, dtm, dom)
    expected = np.zeros(cls.shape, dtype=bool)
    expected[32:48, 32:48] = True          # more than 2 m from the nearest tree
    assert np.array_equal(opened, expected)
    assert stats["forest_to_open"] == 16 * 16 and stats["open_patches"] == 1
    assert stats["forest_cells"] == cls.size and stats["small_patches_kept"] == 0


def test_a_closed_stand_stays_forest_gaps_and_all():
    cls, dtm, dom = world()
    dom[:] = TALL
    dom[10:14, 10:14] = GROUND             # a 4 m gap: every cell within 2 m of a crown
    dom[40:43, :] = GROUND                 # a 3 m wide ride right across the stand
    dom[60:61, 60:61] = GROUND - 0.4       # a single low cell, within the surface-gap tolerance
    opened, stats = forest_correction(cls, dtm, dom)
    assert not opened.any()
    assert stats["forest_to_open"] == 0 and stats["open_patches"] == 0


def test_the_crown_fringe_stays_forest():
    cls, dtm, dom = world()
    dom[:, :30] = TALL                     # a stand edge along column 29
    dom[:, 30] = GROUND + 2.9              # the crown's edge, just under the canopy height
    opened, _ = forest_correction(cls, dtm, dom)
    assert not opened[:, :32].any()        # columns 30 and 31 are within 2 m of column 29
    assert opened[:, 32:].all()            # 3 m out, and beyond, is open land


def test_canopy_starts_at_three_metres():
    cls, dtm, dom = world()
    dom[40, 40] = GROUND + classes.CANOPY_MIN_M - 0.01      # a shrub
    assert forest_correction(cls, dtm, dom)[0].all()
    dom[40, 40] = GROUND + classes.CANOPY_MIN_M              # a young tree
    opened, _ = forest_correction(cls, dtm, dom)
    r, q = np.nonzero(~opened)
    assert set(zip(r.tolist(), q.tolist())) == {
        (40 + dr, 40 + dq) for dr in range(-2, 3) for dq in range(-2, 3) if dr * dr + dq * dq <= 4}


def test_a_roof_never_counts_as_a_tree():
    cls, dtm, dom = world()
    cls[30:36, 30:38] = BUILDING           # a registered footprint, painted before the correction
    dom[29:37, 29:39] = GROUND + 5.0       # its roof, eaves one cell beyond the footprint
    opened, stats = forest_correction(cls, dtm, dom)
    assert not opened[30:36, 30:38].any()  # the footprint is not forest and is never touched
    ring = np.zeros(cls.shape, dtype=bool)
    ring[27:39, 27:41] = True
    ring[30:36, 30:38] = False
    assert opened[ring].all()              # right up to the walls: nothing kept a fringe
    assert stats["forest_to_open"] == cls.size - 6 * 8 == stats["forest_cells"]
    # The same raised block with no footprint (a roof without a register point) is taken
    # for canopy, as a flat patch of crowns would be.
    cls[30:36, 30:38] = FOREST
    opened, _ = forest_correction(cls, dtm, dom)
    assert not opened[29:37, 27:41].any() and not opened[27:39, 29:39].any()


@pytest.mark.parametrize("size,opens", [(6, False), (8, False), (9, True), (12, True)])
def test_small_treeless_patches_stay_forest(size, opens):
    # A hole of n x n cells has (n - 4)^2 cells more than 2 m from the canopy; 25 m2 opens.
    cls, dtm, dom = stand_with_hole(size)
    opened, stats = forest_correction(cls, dtm, dom)
    inner = (size - 4) ** 2
    assert opened.sum() == (inner if opens else 0)
    assert stats["small_patch_cells_kept"] == (0 if opens else inner)
    assert stats["small_patches_kept"] == (0 if opens or inner == 0 else 1)


@pytest.mark.parametrize("beside,opens", [(ROAD, True), (OPEN, True), (FARMLAND, True),
                                          (LAKE, False), (SEA, False)])
def test_a_small_patch_beside_other_land_opens(beside, opens):
    # A treeless notch in a stand's edge, 10 x 6 cells, leaves 6 x 4 candidates: under the
    # minimum, so inside a stand it would stay. Beside a road, a lawn or a field it is
    # the open ground there, not a gap; beside a river or the sea it is still a gap.
    cls, dtm, dom = world()
    dom[:] = TALL
    cls[:, 50:56] = beside
    dom[:, 50:56] = GROUND
    dom[10:20, 56:62] = GROUND
    opened, stats = forest_correction(cls, dtm, dom)
    notch = np.zeros(cls.shape, dtype=bool)
    notch[12:18, 56:60] = True
    assert np.array_equal(opened, notch if opens else np.zeros_like(notch))
    assert stats["small_patches_opened_at_edges"] == (1 if opens else 0)
    assert stats["small_patches_kept"] == (0 if opens else 1)


def test_a_small_patch_beside_a_building_opens():
    # A yard between a wall and the trees: a treeless notch of 8 x 6 cells beside a
    # registered footprint whose roof stands 5 m up. The roof is not a tree and the
    # footprint is land of another class, so the small patch opens. The column against
    # the wall reaches one row further each way than the rest, because the crowns over
    # the eaves (within one cell of the footprint) are masked with the roof.
    cls, dtm, dom = world()
    dom[:] = TALL
    cls[5:25, 50:56] = BUILDING
    dom[5:25, 50:56] = GROUND + 5.0
    dom[10:18, 56:62] = GROUND
    opened, stats = forest_correction(cls, dtm, dom)
    expected = np.zeros(cls.shape, dtype=bool)
    expected[11:17, 56] = True
    expected[12:16, 57:60] = True
    assert expected.sum() < classes.MIN_OPEN_M2      # under the minimum: only the edge opens it
    assert np.array_equal(opened, expected)
    assert stats["small_patches_opened_at_edges"] == 1 and stats["small_patches_kept"] == 0


@pytest.mark.parametrize("below,opens", [(0.5, True), (classes.SURFACE_GAP_M, True),
                                         (classes.SURFACE_GAP_M + 0.05, False)])
def test_a_surface_just_below_the_terrain_is_ground_not_a_hole(below, opens):
    # The two models can disagree by a few decimetres on open ground. Up to SURFACE_GAP_M
    # below the terrain the surface is still a surface, and the clearing opens as it would
    # at the terrain's own height; any deeper and it is a hole, which keeps the forest.
    cls, dtm, dom = stand_with_hole(20)
    dom[30:50, 30:50] = GROUND - below
    opened, stats = forest_correction(cls, dtm, dom)
    expected = np.zeros(cls.shape, dtype=bool)
    if opens:
        expected[32:48, 32:48] = True
    assert np.array_equal(opened, expected)
    assert stats["surface_hole_cells"] == (0 if opens else 20 * 20)


def test_diagonal_neighbours_make_one_patch():
    # Treeless ground exactly where 25 cells on a diagonal are more than 2 m from a tree:
    # each touches the next only at a corner, and together they reach the minimum.
    cls, dtm, dom = world((60, 60))
    dom[:] = TALL
    for k in range(25):
        for dr in range(-2, 3):
            for dq in range(-2, 3):
                if dr * dr + dq * dq <= 4:
                    dom[5 + k + dr, 5 + k + dq] = GROUND
    opened, stats = forest_correction(cls, dtm, dom)
    r, q = np.nonzero(opened)
    assert set(zip(r.tolist(), q.tolist())) == {(5 + k, 5 + k) for k in range(25)}
    assert stats["open_patches"] == 1 and stats["small_patches_kept"] == 0


def test_only_forest_changes_and_only_to_open_land():
    cls, dtm, dom = world()
    cls[:, :10] = SEA
    dtm[:, :10] = 0.0
    dom[:, :10] = 0.0
    cls[:, 10:20] = LAKE
    cls[:, 20:30] = BOG
    cls[:, 30:40] = OPEN
    cls[5:10, 45:50] = BUILDING
    dom[5:10, 45:50] = GROUND + 6.0
    before = cls.copy()
    opened, _ = forest_correction(cls, dtm, dom)
    assert np.array_equal(cls, before)                       # it reports; it does not write
    assert (before[opened] == FOREST).all()
    assert opened[:, 40:].sum() == (before[:, 40:] == FOREST).sum()
    after = cls.copy()
    after[opened] = OPEN
    assert np.array_equal(after[:, :40], before[:, :40])     # sea, lake, bog, open unchanged
    assert not ((after == FOREST) & (before != FOREST)).any()


def test_holes_in_the_surface_model_keep_forest():
    cls, dtm, dom = world()
    dom[20:30, 20:30] = 0.0                # nodata stored as 0 m, on ground at 10 m
    dom[50:60, 50:60] = np.nan             # no surface value at all
    dtm[70:, :] = np.nan                   # no terrain: outside every chunk
    opened, stats = forest_correction(cls, dtm, dom)
    for r0, q0 in ((20, 20), (50, 50)):     # each hole and 2 m round it (square corners aside)
        assert not opened[r0:r0 + 10, q0 - 2:q0 + 12].any()
        assert not opened[r0 - 2:r0 + 12, q0:q0 + 10].any()
    assert not opened[70:, :].any()
    assert opened[40, 40] and opened[65, 10]
    assert stats["surface_hole_cells"] == 200
    assert stats["forest_cells"] == 70 * 80            # only forest with a terrain height


def test_it_is_deterministic_and_leaves_its_inputs_alone():
    rng = np.random.default_rng(7)
    cls, dtm, dom = world((120, 150))
    dtm += rng.normal(0.0, 1.0, dtm.shape)
    dom = dtm + np.where(rng.random(dtm.shape) < 0.35, rng.uniform(0.0, 20.0, dtm.shape), 0.0)
    cls[rng.random(cls.shape) < 0.1] = OPEN
    copies = [a.copy() for a in (cls, dtm, dom)]
    first = forest_correction(cls, dtm, dom)
    second = forest_correction(cls, dtm, dom)
    assert np.array_equal(first[0], second[0]) and first[1] == second[1]
    for a, b in zip((cls, dtm, dom), copies):
        assert np.array_equal(a, b)


def test_shapes_must_agree():
    cls, dtm, dom = world()
    with pytest.raises(ValueError):
        forest_correction(cls, dtm, dom[:-1])


# -- the band and the build step ----------------------------------------------------------

I, J = 900, 27700
H1 = Level("h1", 1, 100, 240, 1, grid.NEAREST)
H5 = Level("h5", 5, 500, 240, 1, grid.BILINEAR)


def band_ctx(surface=True):
    """A ctx with one h1 chunk of forest over flat ground, and its class band."""
    g = LevelGrid(H1, [(I, J)])
    terrain = ChunkSet()
    terrain[(I, J)] = np.full((242, 242), GROUND, dtype=np.float32)
    forest = Area(code=FOREST, tier="landcover", source_type="test",
                  polygon=box(g.west, g.south, g.east, g.north))
    band = classes.build_class_band([H1, H5], {"h1": terrain}, [forest], [])
    ctx = SimpleNamespace(class_band=band, chunks={"h1": terrain}, map=mapsteps.MapInputs())
    if surface:
        dom = np.full((242, 242), GROUND, dtype=np.float32)
        dom[:, :120] = TALL                # trees on the west half, a lawn on the east
        ctx.map.surface = ChunkSet({(I, J): dom})
    return ctx


def test_the_step_corrects_h1_and_records_it():
    ctx = band_ctx()
    mapsteps.step_forest(ctx)
    cut = ctx.class_band.source(H1, I, J, None)
    assert (cut[:, :122] == FOREST).all()          # the stand and its 2 m fringe
    assert (cut[:, 122:] == OPEN).all()            # the lawn
    stats = ctx.class_band.stats()["h1"]
    record = stats["forest_correction"]
    assert record["forest_to_open"] == 242 * 120
    assert stats["class_cells"] == {str(FOREST): 242 * 122, str(OPEN): 242 * 120}
    assert record["canopy_min_m"] == 3.0 and record["fringe_m"] == 2.0


def test_the_step_without_a_surface_model_changes_nothing():
    ctx = band_ctx(surface=False)
    mapsteps.step_forest(ctx)
    assert (ctx.class_band.get("h1").classes == FOREST).all()
    assert ctx.class_band.stats()["h1"]["forest_correction"] == {"skipped": "no surface model"}


def test_the_step_is_in_the_shared_order():
    names = [name for name, _ in mapsteps.SHARED_STEPS]
    assert names.index("buildings") < names.index("forest") < names.index("trees")
