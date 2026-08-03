library(sf)

## UpperBasin Simplify
x <- st_read("Layers/UpperBasin.geojson")
xx <- x |>
  st_reverse() |>
  st_simplify(dTolerance = 100)

## Check coordinate count and visible resolution of two versions
nrow(st_coordinates(x))
nrow(st_coordinates(xx))
par(mfcol = c(1, 2))  ## Splits window into two plotting areas
plot(st_geometry(x), main = "Full resolution")
plot(st_geometry(xx), main = "Simplified boundary")

## Save the modified polygon to disk
st_write(xx, "Layers/UpperBasin_simple.geojson", append = FALSE)



## Reservoirs Simplify
y <- st_read("Layers/Reservoirs.geojson")

yy <- y |>
  st_reverse()
## no st_simplify() here, reservoir polygons are already small,
## simplifying could distort their shape/centroid at this scale

## Check coordinate count before/after (should be unchanged, since we're not simplifying)
nrow(st_coordinates(y))
nrow(st_coordinates(yy))

## Visual check
par(mfcol = c(1, 2))
plot(st_geometry(y), main = "Original")
plot(st_geometry(yy), main = "Reversed")

## Save the fixed version
st_write(yy, "Layers/Reservoirs_simple.geojson", append = FALSE)