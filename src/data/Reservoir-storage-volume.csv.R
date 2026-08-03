## Adapted from C:/Grand Canyon Trust Dropbox/GIS_Team/Water/ColoradoRiver/ReservoirDashboard/Scripts/1-Update-data.R

library(data.table)
library(anytime)    ## anydate()
library(httr)       ## GET() & content()
library(readr)


##------------------------------------------------------------------------------
## (0) Helper functions
##------------------------------------------------------------------------------

DT <- function(x, ...) {
  data.table:::`[.data.table`(x, ...)[]
}

read_RISE <- function(itemId, after = "2025-05-07") {
    URL <- "https://data.usbr.gov/rise/api/result/download"
    PARAMS <-
        list(type = "csv",
             itemId = itemId,
             after = after,
             order = "ASC")
    GET(url = URL, query = PARAMS) |>
        content() |>
        fread(skip =  "timeStep") |>
        DT(, .(Location = factor(Location,
                                 levels = reservoirs$Name,
                                 labels = reservoirs$ShortName),
               Date = anydate(`Datetime (UTC)`),
               Volume = Result))
}


##------------------------------------------------------------------------------
## (1) Read locally saved data
##------------------------------------------------------------------------------

reservoirs <-
    fread("./src/historical-data/Reservoirs.csv")
storage_saved <-
    readRDS("./src/historical-data/Reservoir-storage-to-2025-05-06.rds")


##------------------------------------------------------------------------------
## (2) Request and append data after 2025-05-06
##------------------------------------------------------------------------------

storage_recent <- reservoirs$id_storage |>
    lapply(read_RISE) |>
    rbindlist()

storage   <- rbind(storage_saved, storage_recent) |>
    setorder(Location, Date) |>
    DT(Date >= "1971-01-01", )

## Brendan's code uses lowercase names
levels(storage$Location) <- tolower(levels(storage$Location))

## Write results to stdout (as required for an Observable Framework data loader)
cat(format_csv(storage, na = ""))

## Manually write to file, solely for testing purposes
## fwrite(storage, "../.observablehq/cache/data/Reservoir-storage-volume.csv", na = "")
