importScripts(
    "https://unpkg.com/kdbush@3.0.0/kdbush.min.js",
    'https://unpkg.com/tinyqueue@2.0.0/tinyqueue.min.js',
    "https://cdn.jsdelivr.net/npm/@turf/turf@5/turf.min.js"
);

const thisUrl = new URL(self.location);

let locations;
let index;

const WalkMetersPerMinute = 1.0 * 60;

let allRoutes = null;
let routesMap = null;

const deg2rad = x => x * Math.PI / 180;
const EarthRadius = 6371000;
const MaxWalkRadius = 1800;
const FirstStopMinWaitMinutes = 1.0;

let curComputeId = null;
let tripTimesCache = {};

// todo: support multiple agencies on one map
const agencyId = thisUrl.searchParams.get('agency_id');

const PrecomputedStatsVersion = thisUrl.searchParams.get('precomputed_stats_version');
const RoutesVersion = thisUrl.searchParams.get('routes_version');
const BaseUrl = thisUrl.searchParams.get('base');
const S3Bucket = thisUrl.searchParams.get('s3_bucket');

function loadJson(url)
{
    if (url[0] == '/' && baseUrl)
    {
        url = baseUrl + url;
    }

    return new Promise((resolve, reject) => {
        let req = new XMLHttpRequest();
        req.addEventListener("load", function() {
            try
            {
                var res = JSON.parse(req.responseText);
            }
            catch (e)
            {
                return reject({message: "Invalid JSON", status: req.status});
            }
            resolve(res);
        });
        req.onerror = () => reject({message: req.statusText, status: req.status});
        req.open("GET", url);
        req.send();
    });
}

function loadRoutes()
{
    if (allRoutes)
    {
        return Promise.resolve(allRoutes);
    }
    else
    {
        return loadJson(`https://${S3Bucket}.s3.amazonaws.com/routes/${RoutesVersion}/routes_${RoutesVersion}_${agencyId}.json.gz`).then(function(data) {
            allRoutes = data.routes;
            return allRoutes;
        });
    }
}

function loadRoute(routeId)
{
    if (routesMap)
    {
        return Promise.resolve(routesMap[routeId]);
    }
    else
    {
        return loadRoutes().then(function(routes) {
            routesMap = {};
            for (const route of routes) {
                routesMap[route.id] = route;
            }
            return routesMap[routeId];
        });
    }
}

function sendError(err) {
    postMessage({type: 'error', error: err});
};

function findStopDirectionAndIndex(stopId, routeInfo)
{
    for (let dirInfo of routeInfo.directions)
    {
        let numStops = dirInfo.stops.length;
        for (let i = 0; i < numStops; i++)
        {
            if (dirInfo.stops[i] === stopId)
            {
                return {index:i, direction: dirInfo};
            }
        }
    }
    return null;
}

function distance(latlon1, latlon2)
{
    const lat1 = latlon1.lat || latlon1[0],
        lon1 = latlon1.lon || latlon1.lng || latlon1[1],
        lat2 = latlon2.lat || latlon2[0],
        lon2 = latlon2.lon || latlon2.lng || latlon2[1];
    return turf.distance([lon1,lat1],[lon2,lat2]) * 1000;
}

function getTimePath(timeStr)
{
    return timeStr ? ('_' + timeStr.replace(/:/g,'').replace('-','_').replace(/\+/g,'%2B')) : '';
}

async function getTripTimes(agencyId, dateStr, timeStr)
{
    const cacheKey = agencyId + dateStr + timeStr;
    let tripTimes = tripTimesCache[cacheKey];

    if (!tripTimes)
    {
        let timePath = getTimePath(timeStr);

        let s3Url = 'https://'+S3Bucket+'.s3.amazonaws.com/observed-stats/'+PrecomputedStatsVersion+'/'+agencyId+'/'+
            dateStr.replace(/\-/g, '/')+
            '/observed-stats_'+PrecomputedStatsVersion+'_'+agencyId+'_median-trip-times_'+dateStr+timePath+'.json.gz';

        tripTimes = tripTimesCache[cacheKey] = await loadJson(s3Url).catch(function(e) {
            e.message = 'error loading trip times: ' + e.message;
            sendError(e);
            throw e;
        });
    }

    return tripTimes;
}

async function getTripTimesFromStop(agencyId, routeId, directionId, startStopId, dateStr, timeStr)
{
    const tripTimes = await getTripTimes(agencyId, dateStr, timeStr);

    let routeStats = tripTimes.routes[routeId];
    if (!routeStats)
    {
        return null;
    }

    let directionStats = routeStats.directions[directionId];
    if (!directionStats)
    {
        return null;
    }

    let medianTripTimes = directionStats.medianTripTimes;
    if (!medianTripTimes)
    {
        return null;
    }

    return medianTripTimes[startStopId];
}

async function getWaitTimeAtStop(agencyId, routeId, directionId, stopId, dateStr, timeStr)
{
    const tripTimes = await getTripTimes(agencyId, dateStr, timeStr);

    let routeStats = tripTimes.routes[routeId];
    if (!routeStats)
    {
        return null;
    }

    let directionStats = routeStats.directions[directionId];
    if (!directionStats)
    {
        return null;
    }

    let medianWaitTimes = directionStats.medianWaitTimes;
    if (!medianWaitTimes)
    {
        return null;
    }

    return medianWaitTimes[stopId];
}

function computeIsochrones(latlng, tripMins, enabledRoutes, dateStr, timeStr, computeId)
{
    curComputeId = computeId;

    let enabledRoutesMap = {};
    for (let routeId of enabledRoutes)
    {
        enabledRoutesMap[routeId] = true;
    }

    // Get approximate distance in meters for 1 degree change in latitude/longitude
    // so that addNearbyLocations can convert a radius in meters to approximate delta latitude/longitude
    // to search the KDBush index for stop locations within the bounding box.
    // For longitude, this is only approximate since a delta of 1 degree longitude is not a fixed distance,
    // but it does not vary much over the size of a city (up to 0.2% within SF depending on latitude)
    let degLatDist = distance(latlng, [latlng.lat-0.1, latlng.lng])*10;
    let degLonDist = distance(latlng, [latlng.lat, latlng.lng-0.1])*10;

    let queue = new TinyQueue([], function(a, b) {
        return a.tripMin - b.tripMin;
    });

    let drawableLocations = [];
    let numReachedLocations = 0;
    let totalLocations = 0;
    let startTime = new Date().getTime();
    let maxTripMin = tripMins[tripMins.length - 1];
    let displayedTripMins = new TinyQueue(tripMins);

    let reachedIds = {}; // map of location id => true (set when location dequeued)
    let bestTripMins = {}; // map of location id => best trip min enqueued so far (set when location enqueued)

    function addNearbyLocations(reachedLocation, radius)
    {
        let latRadius = radius/degLatDist;
        let lonRadius = radius/degLonDist;
        let results = index.range(reachedLocation.lat-latRadius, reachedLocation.lng-lonRadius, reachedLocation.lat+latRadius, reachedLocation.lng+lonRadius).map(id => locations[id]);

        for (loc of results)
        {
            let locId = loc.id;
            if (reachedIds[locId])
            {
                continue;
            }

            let latlon = loc.lat_lon;
            let dist = distance(latlon, reachedLocation);
            if (dist <= radius)
            {
                let walkMin = dist / WalkMetersPerMinute;
                let nextTripMin = reachedLocation.tripMin + walkMin;

                if (bestTripMins[locId] < nextTripMin)
                {
                    continue;
                }
                bestTripMins[locId] = nextTripMin;

                let nextTripItems = reachedLocation.tripItems.slice();

                nextTripItems.push({t: walkMin, desc:`walk to ${loc.title}`});

                //console.log(`can walk to ${loc.id} ${loc.title} (${dist.toFixed(0)} m) in ${nextTripMin.toFixed(1)} min`);
                queue.push({
                    id: locId,
                    tripMin: nextTripMin,
                    routes:reachedLocation.routes,
                    tripItems: nextTripItems,
                    lat: latlon[0],
                    lng: latlon[1],
                    loc: loc,
                    title: loc.title,
                    walked: true
                });
            }
        }
    }

    async function addReachableStopsAfterStop(stopId, routeInfo, reachedLocation)
    {
        let res = findStopDirectionAndIndex(stopId, routeInfo);
        if (res)
        {
            //console.log(`starting from ${stopId} (${routeInfo.stops[stopId].title}) on ${routeInfo.id}`);

            let { direction, index } = res;

            let tripMin = reachedLocation.tripMin;

            let stopInfo = routeInfo.stops[stopId];

            let waitMin = await getWaitTimeAtStop(agencyId, routeInfo.id, direction.id, stopId, dateStr, timeStr);
            if (!waitMin)
            {
                return;
            }

            let departureMin = tripMin + waitMin;

            let tripTimes = await getTripTimesFromStop(agencyId, routeInfo.id, direction.id, stopId, dateStr, timeStr);
            if (!tripTimes)
            {
                return;
            }

            let waitItem = {
                t:waitMin,
                desc:`wait for ${routeInfo.id}`
            };

            const startIndex = direction.loop ? 0 : (index + 1);

            for (let i = startIndex; i < direction.stops.length; i++)
            {
                if (i == index) // no point in doing complete loops
                {
                    continue;
                }

                let nextStopId = direction.stops[i];
                let nextStopInfo = routeInfo.stops[nextStopId];

                let busMin = tripTimes[nextStopId];
                if (!busMin || busMin <= 0)
                {
                    continue;
                }

                let nextTripMin = departureMin + busMin;

                if (nextTripMin <= maxTripMin)
                {
                    let nextLocId = `${nextStopInfo.lat},${nextStopInfo.lon}`;
                    if (bestTripMins[nextLocId] < nextTripMin)
                    {
                        continue;
                    }
                    bestTripMins[nextLocId] = nextTripMin;

                    let nextTripItems = reachedLocation.tripItems.slice();

                    nextTripItems.push(waitItem);
                    nextTripItems.push({
                        t:busMin,
                        desc:`take ${routeInfo.id} to ${nextStopInfo.title}`,
                        route: routeInfo.id,
                        direction: direction.id,
                        fromStop: stopId,
                        toStop: nextStopId
                    });

                    let nextRoutes = reachedLocation.routes ? `${reachedLocation.routes}/${routeInfo.id}` : routeInfo.id;

                    //console.log(`will reach ${nextStopInfo.location_id} ${nextStopId} (${nextStopInfo.title}) in ${nextTripMin.toFixed(1)} min`);
                    queue.push({
                        id: nextLocId,
                        tripMin: nextTripMin,
                        routes: nextRoutes,
                        lat: nextStopInfo.lat,
                        lng: nextStopInfo.lon,
                        title: nextStopInfo.title,
                        tripItems: nextTripItems
                    });
                }
            }
        }
    }

    let lastUnion = null;

    function showReachableLocations(tripMin)
    {
       while (displayedTripMins.length && tripMin >= displayedTripMins.peek() && computeId === curComputeId)
       {
            let displayedTripMin = displayedTripMins.pop();
            let reachableCircles = [];
            let turfCircles = [];

            for (let reachedLocation of drawableLocations)
            {
                let walkRadius = Math.min(WalkMetersPerMinute * (displayedTripMin - reachedLocation.tripMin), MaxWalkRadius);
                if (walkRadius > 0)
                {
                    turfCircles.push(
                        turf.circle([reachedLocation.lng, reachedLocation.lat], walkRadius / 1000, {steps:16})
                    );
                    reachableCircles.push(Object.assign({radius: walkRadius}, reachedLocation));
                }
            }

            let union = turf.union.apply(turf, turfCircles);

            let unionDiff = lastUnion ? turf.difference(union, lastUnion) : union;

            lastUnion = union;

            postMessage({
                type: 'reachableLocations',
                tripMin: displayedTripMin,
                computeId: computeId,
                circles: reachableCircles,
                geoJson: unionDiff
            });
       }
    }

    async function processLocations()
    {
        // Loop dequeues locations from a priority queue sorted by tripMin.
        // When a location is dequeued, it is considered "reached".
        // (The algorithm will skip that location if it appears again later with a larger tripMin.)
        //
        // There are three types of locations in the queue - locations that the person walks to,
        // locations that the person takes a bus to, and the initial location.
        //
        // If the person walks to a location, for all routes that stop at the location,
        // all subsequent stops along those routes that are reachable within the max
        // trip time are enqueued, with a tripMin that adds the wait time and trip time.
        //
        // If the person took a bus to a location (or if it is the initial location),
        // all other stops within walking distance of that location are enqueued,
        // with a tripMin that adds the walking time.
        //
        // As the algorithm progresses, it compute isochrones whenever it reaches a time specified in
        // the tripMins array, and sends the isochrones to the UI for rendering.

        let numProcessed = 0;
        while (true)
        {
            if (computeId !== curComputeId)
            {
                console.log("compute id changed!");
                return;
            }

            if (numProcessed++ > 1000)
            {
                setTimeout(processLocations, 1); // give onmessage a chance to handle new messages
                return;
            }

            if (!queue.length)
            {
                break;
            }

            totalLocations++;

            let reachedLocation = queue.pop();

            let locId = reachedLocation.id;
            if (reachedIds[locId])
            {
                continue;
            }

            reachedIds[locId] = true;
            numReachedLocations++;

            //console.log(`reached ${reachedLocation.title} in ${reachedLocation.tripMin}`);

            if (reachedLocation.walked)
            {
                let promises = reachedLocation.loc.stops.map(function(stop) {
                    let routeId = stop.routeId;
                    if (!enabledRoutesMap[routeId])
                    {
                        return null;
                    }

                    return loadRoute(routeId)
                        .catch(function(e) {
                            e.message = 'error loading route: ' + e.message;
                            e.routeId = routeId;
                            sendError(e);
                            throw e;
                        })
                        .then(function(routeInfo) {
                            return addReachableStopsAfterStop(stop.id, routeInfo, reachedLocation);
                        });
                });

                await Promise.all(promises);
            }
            else
            {
                drawableLocations.push(reachedLocation);

                let tripMin = reachedLocation.tripMin;

                showReachableLocations(tripMin);

                let walkRadius = Math.min(WalkMetersPerMinute * (maxTripMin - reachedLocation.tripMin), MaxWalkRadius);

                if (walkRadius >= 0)
                {
                    //console.log(reachedLocation);
                    addNearbyLocations(reachedLocation, walkRadius);
                }
            }
        }

        showReachableLocations(maxTripMin);

        let endTime = new Date().getTime();
        console.log(`${computeId} done (${numReachedLocations} reached locations, ${totalLocations} processed in ${endTime-startTime} ms)!`);
    }

    queue.push({
        id: "_init_",
        tripMin: 0,
        lat: latlng.lat,
        lng: latlng.lng,
        routes:null,
        title: 'initial position',
        tripItems: [],
        walked: false
    });
    processLocations();
}

function makeLocations(routes)
{
    let locationsMap = {};
    let locations = [];
    for (const route of routes)
    {
        for (const stopId in route.stops)
        {
            const stopInfo = route.stops[stopId];
            const locationKey = `${stopInfo.lat},${stopInfo.lon}`;
            if (!locationsMap[locationKey])
            {
                const locInfo = {
                    id: locationKey,
                    lat_lon: [stopInfo.lat, stopInfo.lon],
                    title: stopInfo.title,
                    stops: []
                };

                locationsMap[locationKey] = locInfo;
                locations.push(locInfo);
            }
            locationsMap[locationKey].stops.push({
                routeId: route.id,
                id: stopId
            });
        }
    }
    return locations;
}

async function init()
{
    const routes = await loadRoutes().catch(function(e) {
        sendError("error loading locations: " + e);
        throw e;
    });

    locations = makeLocations(routes);

    index = new KDBush(locations, p => p.lat_lon[0], p => p.lat_lon[1]);

    onmessage = function(e) {

        let data = e.data;

        if (data && data.action === 'computeIsochrones')
        {
            computeIsochrones(data.latlng, data.tripMins, data.routes, data.dateStr, data.timeStr, data.computeId);
        }
        else
        {
            console.log('Message received from main script');
            console.log(data);
        }

        postMessage({type: 'ok'});
    }
    postMessage({type: 'ready'});
}

init();
