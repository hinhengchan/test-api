var chai = require('chai'),
    should = chai.should(),
    expect = chai.expect,
    assertArrays = require('chai-arrays');
    chai.use(assertArrays),
    randomLocation = require('random-location'),
    moment = require('moment-timezone'),
    api = require('superagent');

describe('Order', function () {
    // service endpoint
    const ENDPOINT = 'http://localhost:51544';
    // office location - Lai Chi Kok
    const OFFICE = {
        latitude: 22.334600,
        longitude: 114.147640
    };
    // in meters
    const RADIUS = 10000;
    // tolerance for amount calculation
    const TOLERANCE = 0.01;
    // retry x times
    const RETRY = 3;

    // set max number of retry for each test
    this.retries(RETRY);

    /**
      * @desc generate a random integer within provided range
      * @param int $min - the min of the desired range
      * @param int $max - the max of the desired range
      * @return int - random integer within provided range
    **/
    function generateRandomInteger(min, max) {
        return Math.floor(min + Math.random()*(max + 1 - min))
    }

    /**
      * @desc convert location with latitude/longitude to lat/lng
      * @param object $location - with latitude/longitude attributes
      * @return object - with lat/lng attributes
    **/
    function prepareLatLng(location) {
        var latLng = Object.assign({}, location);
        latLng.lat = latLng.latitude;
        latLng.lng = latLng.longitude;
        delete latLng.latitude;
        delete latLng.longitude;

        return latLng;
    }

    /**
      * @desc prepare for API payload
      * @param int $numberOfLegs - number of legs include in the trip
      * @param bool $isSurcharge - is between 9pm - 5am
      * @param int $center (optional) - location object used as center of circle
      * @param int $rad (optional) - radius from the center for generating random points
      * @return object - API payload with stops attribute and optionally with orderAt attribute depending on $isSurcharge
    **/
    function prepareTrip(numberOfLegs, isSurcharge, center = OFFICE, rad = RADIUS) {
        // get random number if numberOfLegs is not defined
        if (!numberOfLegs && numberOfLegs != 0) {
            numberOfLegs = generateRandomInteger(1, 10);
        }

        // trip starts from office location
        var trip = {};
        trip.stops = [];
        trip.stops.push(prepareLatLng(center));

        // isSurcharge = 22 - 4; otherwise, 5 - 21
        var hour = generateRandomInteger(5, 21);
        if (isSurcharge) {
            hour = generateRandomInteger(-2, 4);
        }

        // set orderAt date to control price calculation
        var orderAt = moment().tz('Asia/Hong_Kong').add(1, 'days').set({ hours: hour }).format();

        if (isSurcharge !== null) {
            trip.orderAt = orderAt;
        }

        // add locations to trip
        for (i = 0; i < numberOfLegs; i++) {
            var randomPoint = prepareLatLng(randomLocation.randomCirclePoint(center, rad));
            trip.stops.push(randomPoint);
        }

        return trip;
    }

    /**
      * @desc check if fare amount is correct
      * @param float $actualFareAmount - amount to be tested
      * @param int $totalDistance - sum of distance for the whole trip
      * @param bool $isSurcharge - is between 9pm - 5am
      * @return bool - true if amount is expected within tolerance depending on $isSurcharge
    **/
    function checkFareAmount(actualFareAmount, totalDistance, isSurcharge) {
        // between 5am - 9pm
        var expectedFareAmountNormal = 20 + (totalDistance - 2000) / 200 * 5;
        // between 9pm - 5am
        var expectedFareAmountSurcharge = 30 + (totalDistance - 2000) / 200 * 8;

        if (isSurcharge == null) {
            // return true if match either amount
            return Math.abs(actualFareAmount - expectedFareAmountNormal) < TOLERANCE || 
                    Math.abs(actualFareAmount - expectedFareAmountSurcharge) < TOLERANCE;
        } else if (isSurcharge) {
            // return true if match surcharge amount
            return Math.abs(actualFareAmount - expectedFareAmountSurcharge) < TOLERANCE;
        } else {
            // return true if match normal amount
            return Math.abs(actualFareAmount - expectedFareAmountNormal) < TOLERANCE;
        }
    }

    function createOrderAndValidate(done, trip, isSurcharge) {
        api.post(ENDPOINT + '/v1/orders')
            .set('Accept', 'application/json')
            .send(trip)
            .then(res => {
                // check status code
                expect(res.statusCode).to.equal(201);

                // check all fields exist
                expect(res.body).to.have.keys(['id', 'drivingDistancesInMeters', 'fare']);

                // check id (int)
                expect(res.body.id).to.be.a('number');

                // check drivingDistancesInMeters
                var totalDistance = 0;
                expect(res.body.drivingDistancesInMeters).to.be.an('array');
                for (var i in res.body.drivingDistancesInMeters) {
                    expect(res.body.drivingDistancesInMeters[i]).to.be.a('number');
                    totalDistance += res.body.drivingDistancesInMeters[i];
                }

                // check fare (object)
                expect(res.body.fare).to.be.an('object')
                expect(res.body.fare).to.have.property("amount");
                expect(parseFloat(res.body.fare.amount)).to.be.a('number');
                expect(checkFareAmount(parseFloat(res.body.fare.amount), totalDistance, isSurcharge)).to.be.true;
                expect(res.body.fare).to.have.property("currency").and.to.be.a('string').and.to.equal('HKD');

                done();
            })
            .catch(err => {
                console.log('error: ' + err.message);
                console.log('max retry attempts: ' + RETRY);
            });
    }

    function fetchOrderAndValidate(done, order, trip, status) {
        api.get(ENDPOINT + '/v1/orders/' + order.id)
            .then(res => {
                // check status code
                expect(res.statusCode).to.equal(200);

                // check all fields exist
                expect(res.body).to.have.keys(['id', 'stops', 'drivingDistancesInMeters', 'fare', 'status', 'orderDateTime', 'createdTime']);

                // check id (int)
                expect(res.body.id).to.be.a('number').and.to.equal(order.id);

                // check stops (array)
                expect(res.body.stops).to.be.an('array');
                expect(res.body.stops.length).to.equal(trip.stops.length);
                for (var i in res.body.stops) {
                    expect(res.body.stops[i]).to.have.keys(['lat', 'lng']);
                    expect(res.body.stops[i].lat).to.be.a('number');
                    expect(res.body.stops[i].lng).to.be.a('number');
                }

                // check drivingDistancesInMeters (array)
                var totalDistance = 0;
                expect(res.body.drivingDistancesInMeters).to.be.an('array').and.to.be.equalTo(order.drivingDistancesInMeters);
                for (var i in res.body.drivingDistancesInMeters) {
                    expect(res.body.drivingDistancesInMeters[i]).to.be.a('number').and.to.equal(order.drivingDistancesInMeters[i]);
                    totalDistance += res.body.drivingDistancesInMeters[i];
                }

                // check fare (object)
                expect(res.body.fare).to.be.an('object')
                expect(res.body.fare).to.have.property("amount");
                expect(parseFloat(res.body.fare.amount)).to.be.a('number');
                expect(checkFareAmount(parseFloat(res.body.fare.amount), totalDistance, null)).to.be.true;
                expect(res.body.fare).to.have.property("currency").and.to.be.a('string').and.to.equal('HKD');

                // check status
                expect(res.body.status).to.be.a('string').and.to.equal(status);

                // check dateTime
                var orderDateTime = new Date(res.body.orderDateTime);
                var createdTime = new Date(res.body.createdTime);
                expect(orderDateTime >= createdTime).to.be.true;

                done();
            })
            .catch(err => {
                console.log('error: ' + err.message);
                console.log('max retry attempts: ' + RETRY);
            });
    };

    describe('POST /v1/orders', function () {
        it('should create order successfully with orderAt and return correct fields and types', function(done) {
            var isSurcharge = false;
            var trip = prepareTrip(null, isSurcharge);

            createOrderAndValidate(done, trip, isSurcharge);
        });

        it('should create order successfully without orderAt', function(done) {
            var isSurcharge = null;
            var trip = prepareTrip(null, isSurcharge);

            createOrderAndValidate(done, trip, isSurcharge);
        });

        it('should create order successfully with more than 10 stops', function(done) {
            var isSurcharge = false;
            var trip = prepareTrip(generateRandomInteger(11,20), isSurcharge);

            createOrderAndValidate(done, trip, isSurcharge);
        });

        it('should create order successfully with correct fare between 5am to 9pm', function(done) {
            var isSurcharge = false;
            var trip = prepareTrip(null, isSurcharge);

            createOrderAndValidate(done, trip, isSurcharge);
        });

        it('should create order successfully with correct fare between 9pm to 5am', function(done) {
            var isSurcharge = true;
            var trip = prepareTrip(null, isSurcharge);

            createOrderAndValidate(done, trip, isSurcharge);
        });

        it('should fail to create order if only one stop', function(done) {
            var trip = prepareTrip(0, null);

            api.post(ENDPOINT + '/v1/orders')
                .set('Accept', 'application/json')
                .send(trip)
                .catch(err => {
                    // check status code
                    expect(err.response.res.statusCode).to.equal(400);

                    // check error message
                    expect(err.response.res.text).to.have.string('error');
                    expect(err.response.res.text).to.have.string('stops');

                    done();
                });
        });

        it('should fail to create order if lat/lng is invalid', function(done) {
            var invalidLatLng = {
                latitude: 22.334600,
                longitude: 115.147640
            };

            var trip = prepareTrip(null, null, invalidLatLng);

            api.post(ENDPOINT + '/v1/orders')
                .set('Accept', 'application/json')
                .send(trip)
                .catch(err => {
                    // check status code
                    expect(err.response.res.statusCode).to.equal(503);

                    // check error message
                    expect(err.response.res.text).to.have.string('Service Unavailable');

                    done();
                });
        });

        it('should fail to create order if payload is missing', function(done) {
            api.post(ENDPOINT + '/v1/orders')
                .set('Accept', 'application/json')
                .catch(err => {
                    // check status code
                    expect(err.response.res.statusCode).to.equal(400);

                    // check error message
                    expect(JSON.parse(err.response.res.text).message).to.be.a('string').that.is.empty;

                    done();
                });
        });
    });

    describe('GET /v1/orders/{orderID}', function () {
        var trip = prepareTrip(null, null);
        var order;

        beforeEach(function (done) {
            // prepare for orders data
            api.post(ENDPOINT + '/v1/orders')
                .set('Accept', 'application/json')
                .send(trip)
                .then(res => {
                    order = res.body;
                    done();
                })
                .catch(err => {
                    console.log('error: ' + err.message);
                    console.log('max retry attempts: ' + RETRY);
                });
        });

        it('should fetch order details successfully if order is ASSIGNING and return correct fields and types', function(done) {
            fetchOrderAndValidate(done, order, trip, "ASSIGNING");
        });

        it('should fetch order details successfully if order is ONGOING and return correct fields and types', function(done) {
            api.put(ENDPOINT + '/v1/orders/' + order.id + '/take')
                .set('Accept', 'application/json')
                .then(res => {
                    // check status code
                    expect(res.statusCode).to.equal(200);

                    fetchOrderAndValidate(done, order, trip, "ONGOING");
                })
                .catch(err => {
                    console.log('error: ' + err.message);
                    console.log('max retry attempts: ' + RETRY);
                });
        });

        it('should fetch order details successfully if order is CANCELLED and return correct fields and types', function(done) {
            api.put(ENDPOINT + '/v1/orders/' + order.id + '/cancel')
                .set('Accept', 'application/json')
                .then(res => {
                    // check status code
                    expect(res.statusCode).to.equal(200);

                    fetchOrderAndValidate(done, order, trip, "CANCELLED");
                })
                .catch(err => {
                    console.log('error: ' + err.message);
                    console.log('max retry attempts: ' + RETRY);
                });
        });

        it('should fetch order details successfully if order is COMPLETED and return correct fields and types', function(done) {
            api.put(ENDPOINT + '/v1/orders/' + order.id + '/take')
                .set('Accept', 'application/json')
                .then(res => {
                    // check status code
                    expect(res.statusCode).to.equal(200);

                    api.put(ENDPOINT + '/v1/orders/' + order.id + '/complete')
                        .set('Accept', 'application/json')
                        .then(res => {
                            // check status code
                            expect(res.statusCode).to.equal(200);

                            fetchOrderAndValidate(done, order, trip, "COMPLETED");
                        })
                        .catch(err => {
                            console.log('error: ' + err.message);
                            console.log('max retry attempts: ' + RETRY);
                        });
                })
                .catch(err => {
                    console.log('error: ' + err.message);
                    console.log('max retry attempts: ' + RETRY);
                });
        });

        it('should fail to fetch order if order does not exist', function(done) {
            api.get(ENDPOINT + '/v1/orders/' + order.id + 1)
                .catch(err => {
                    // check status code
                    expect(err.response.res.statusCode).to.equal(404);

                    done();
                });
        });
    });

    describe('PUT /v1/orders/{orderID}/take', function () {
        var trip = prepareTrip(null, null);
        var order;

        beforeEach(function (done) {
            // prepare for orders data
            api.post(ENDPOINT + '/v1/orders')
                .set('Accept', 'application/json')
                .send(trip)
                .then(res => {
                    order = res.body;
                    done();
                })
                .catch(err => {
                    console.log('error: ' + err.message);
                    console.log('max retry attempts: ' + RETRY);
                });
        });

        it('should take order successfully if order is ASSIGNING and return correct fields and types', function(done) {
            api.put(ENDPOINT + '/v1/orders/' + order.id + '/take')
                .set('Accept', 'application/json')
                .then(res => {
                    // check status code
                    expect(res.statusCode).to.equal(200);

                    // check all fields exist
                    expect(res.body).to.have.keys(['id', 'status', 'ongoingTime']);

                    // check id (int)
                    expect(res.body.id).to.be.a('number').and.to.equal(order.id);

                    // check status
                    expect(res.body.status).to.be.a('string').and.to.equal("ONGOING");

                    done();
                })
                .catch(err => {
                    console.log('error: ' + err.message);
                    console.log('max retry attempts: ' + RETRY);
                });
        });

        it('should fail to take order if order does not exist', function(done) {
            api.put(ENDPOINT + '/v1/orders/' + order.id + 1 + '/take')
                .catch(err => {
                    // check status code
                    expect(err.response.res.statusCode).to.equal(404);

                    // check error message
                    expect(err.response.res.text).to.have.string('ORDER_NOT_FOUND');

                    done();
                });
        });

        it('should fail to take order if order is already ONGOING', function(done) {
            api.put(ENDPOINT + '/v1/orders/' + order.id + '/take')
                .set('Accept', 'application/json')
                .then(res => {
                    // check status code
                    expect(res.statusCode).to.equal(200);

                    api.put(ENDPOINT + '/v1/orders/' + order.id + '/take')
                        .catch(err => {
                            // check status code
                            expect(err.response.res.statusCode).to.equal(422);

                            // check error message
                            expect(err.response.res.text).to.have.string('not ASSIGNING');

                            done();
                        });
                })
                .catch(err => {
                    console.log('error: ' + err.message);
                    console.log('max retry attempts: ' + RETRY);
                });
        });

        it('should fail to take order if order is CANCELLED', function(done) {
            api.put(ENDPOINT + '/v1/orders/' + order.id + '/cancel')
                .set('Accept', 'application/json')
                .then(res => {
                    // check status code
                    expect(res.statusCode).to.equal(200);

                    api.put(ENDPOINT + '/v1/orders/' + order.id + '/take')
                        .catch(err => {
                            // check status code
                            expect(err.response.res.statusCode).to.equal(422);

                            // check error message
                            expect(err.response.res.text).to.have.string('not ASSIGNING');

                            done();
                        });
                })
                .catch(err => {
                    console.log('error: ' + err.message);
                    console.log('max retry attempts: ' + RETRY);
                });
        });

        it('should fail to take order if order is COMPLETED', function(done) {
            api.put(ENDPOINT + '/v1/orders/' + order.id + '/take')
                .set('Accept', 'application/json')
                .then(res => {
                    // check status code
                    expect(res.statusCode).to.equal(200);

                    api.put(ENDPOINT + '/v1/orders/' + order.id + '/complete')
                        .set('Accept', 'application/json')
                        .then(res => {
                            // check status code
                            expect(res.statusCode).to.equal(200);

                            api.put(ENDPOINT + '/v1/orders/' + order.id + '/take')
                                .catch(err => {
                                    // check status code
                                    expect(err.response.res.statusCode).to.equal(422);

                                    // check error message
                                    expect(err.response.res.text).to.have.string('not ASSIGNING');

                                    done();
                                });
                        })
                        .catch(err => {
                            console.log('error: ' + err.message);
                            console.log('max retry attempts: ' + RETRY);
                        });
                })
                .catch(err => {
                    console.log('error: ' + err.message);
                    console.log('max retry attempts: ' + RETRY);
                });
        });
    });

    describe('PUT /v1/orders/{orderID}/complete', function () {
        var trip = prepareTrip(null, null);
        var order;

        beforeEach(function (done) {
            // prepare for orders data
            api.post(ENDPOINT + '/v1/orders')
                .set('Accept', 'application/json')
                .send(trip)
                .then(res => {
                    order = res.body;
                    done();
                })
                .catch(err => {
                    console.log('error: ' + err.message);
                    console.log('max retry attempts: ' + RETRY);
                });
        });

        it('should complete order successfully if order is ONGOING and return correct fields and types', function(done) {
            api.put(ENDPOINT + '/v1/orders/' + order.id + '/take')
                .set('Accept', 'application/json')
                .then(res => {
                    // check status code
                    expect(res.statusCode).to.equal(200);

                    api.put(ENDPOINT + '/v1/orders/' + order.id + '/complete')
                        .set('Accept', 'application/json')
                        .then(res => {
                            // check status code
                            expect(res.statusCode).to.equal(200);

                            // check all fields exist
                            expect(res.body).to.have.keys(['id', 'status', 'completedAt']);

                            // check id (int)
                            expect(res.body.id).to.be.a('number').and.to.equal(order.id);

                            // check status
                            expect(res.body.status).to.be.a('string').and.to.equal("COMPLETED");

                            done();
                        })
                        .catch(err => {
                            console.log('error: ' + err.message);
                            console.log('max retry attempts: ' + RETRY);
                        });
                })
                .catch(err => {
                    console.log('error: ' + err.message);
                    console.log('max retry attempts: ' + RETRY);
                });
        });

        it('should fail to complete order if order does not exist', function(done) {
            api.put(ENDPOINT + '/v1/orders/' + order.id + 1 + '/complete')
                .set('Accept', 'application/json')
                .catch(err => {
                    // check status code
                    expect(err.response.res.statusCode).to.equal(404);

                    // check error message
                    expect(err.response.res.text).to.have.string('ORDER_NOT_FOUND');

                    done();
                });
        });

        it('should fail to complete order if order is ASSIGNING', function(done) {
            api.put(ENDPOINT + '/v1/orders/' + order.id + '/complete')
                .set('Accept', 'application/json')
                .catch(err => {
                    // check status code
                    expect(err.response.res.statusCode).to.equal(422);

                    // check error message
                    expect(err.response.res.text).to.have.string('not ONGOING');

                    done();
                });
        });

        it('should fail to complete order if order is CANCELLED', function(done) {
            api.put(ENDPOINT + '/v1/orders/' + order.id + '/cancel')
                .set('Accept', 'application/json')
                .then(res => {
                    // check status code
                    expect(res.statusCode).to.equal(200);

                    api.put(ENDPOINT + '/v1/orders/' + order.id + '/complete')
                        .set('Accept', 'application/json')
                        .catch(err => {
                            // check status code
                            expect(err.response.res.statusCode).to.equal(422);

                            // check error message
                            expect(err.response.res.text).to.have.string('not ONGOING');

                            done();
                        });
                })
                .catch(err => {
                    console.log('error: ' + err.message);
                    console.log('max retry attempts: ' + RETRY);
                });
        });

        it('should fail to complete order if order is already COMPLETED', function(done) {
            api.put(ENDPOINT + '/v1/orders/' + order.id + '/take')
                .set('Accept', 'application/json')
                .then(res => {
                    // check status code
                    expect(res.statusCode).to.equal(200);

                    api.put(ENDPOINT + '/v1/orders/' + order.id + '/complete')
                        .set('Accept', 'application/json')
                        .then(res => {
                            // check status code
                            expect(res.statusCode).to.equal(200);

                            api.put(ENDPOINT + '/v1/orders/' + order.id + '/complete')
                                .set('Accept', 'application/json')
                                .catch(err => {
                                    // check status code
                                    expect(err.response.res.statusCode).to.equal(422);

                                    // check error message
                                    expect(err.response.res.text).to.have.string('not ONGOING');

                                    done();
                                });
                        })
                        .catch(err => {
                            console.log('error: ' + err.message);
                            console.log('max retry attempts: ' + RETRY);
                        });
                })
                .catch(err => {
                    console.log('error: ' + err.message);
                    console.log('max retry attempts: ' + RETRY);
                });
        });
    });

    describe('PUT /v1/orders/{orderID}/cancel', function () {
        var trip = prepareTrip(null, null);
        var order;

        beforeEach(function (done) {
            // prepare for orders data
            api.post(ENDPOINT + '/v1/orders')
                .set('Accept', 'application/json')
                .send(trip)
                .then(res => {
                    order = res.body;
                    done();
                })
                .catch(err => {
                    console.log('error: ' + err.message);
                    console.log('max retry attempts: ' + RETRY);
                });
        });

        it('should cancel order successfully if order is ASSIGNING and return correct fields and types', function(done) {
            api.put(ENDPOINT + '/v1/orders/' + order.id + '/cancel')
                .set('Accept', 'application/json')
                .then(res => {
                    // check status code
                    expect(res.statusCode).to.equal(200);

                    // check all fields exist
                    expect(res.body).to.have.keys(['id', 'status', 'cancelledAt']);

                    // check id (int)
                    expect(res.body.id).to.be.a('number').and.to.equal(order.id);

                    // check status
                    expect(res.body.status).to.be.a('string').and.to.equal("CANCELLED");

                    done();
                })
                .catch(err => {
                    console.log('error: ' + err.message);
                    console.log('max retry attempts: ' + RETRY);
                });
        });

        it('should cancel order successfully if order is ONGOING', function(done) {
            api.put(ENDPOINT + '/v1/orders/' + order.id + '/take')
                .set('Accept', 'application/json')
                .then(res => {
                    // check status code
                    expect(res.statusCode).to.equal(200);

                    api.put(ENDPOINT + '/v1/orders/' + order.id + '/cancel')
                        .set('Accept', 'application/json')
                        .then(res => {
                            // check status code
                            expect(res.statusCode).to.equal(200);

                            // check all fields exist
                            expect(res.body).to.have.keys(['id', 'status', 'cancelledAt']);

                            // check id (int)
                            expect(res.body.id).to.be.a('number').and.to.equal(order.id);

                            // check status
                            expect(res.body.status).to.be.a('string').and.to.equal("CANCELLED");

                            done();
                        })
                        .catch(err => {
                            console.log('error: ' + err.message);
                            console.log('max retry attempts: ' + RETRY);
                        });
                })
                .catch(err => {
                    console.log('error: ' + err.message);
                    console.log('max retry attempts: ' + RETRY);
                });
        });

        it('should cancel order successfully if order is already CANCELLED', function(done) {
            api.put(ENDPOINT + '/v1/orders/' + order.id + '/cancel')
                .set('Accept', 'application/json')
                .then(res => {
                    // check status code
                    expect(res.statusCode).to.equal(200);

                    api.put(ENDPOINT + '/v1/orders/' + order.id + '/cancel')
                        .set('Accept', 'application/json')
                        .then(res => {
                            // check status code
                            expect(res.statusCode).to.equal(200);

                            // check all fields exist
                            expect(res.body).to.have.keys(['id', 'status', 'cancelledAt']);

                            // check id (int)
                            expect(res.body.id).to.be.a('number').and.to.equal(order.id);

                            // check status
                            expect(res.body.status).to.be.a('string').and.to.equal("CANCELLED");

                            done();
                        })
                        .catch(err => {
                            console.log('error: ' + err.message);
                            console.log('max retry attempts: ' + RETRY);
                        });
                })
                .catch(err => {
                    console.log('error: ' + err.message);
                    console.log('max retry attempts: ' + RETRY);
                });
        });

        it('should fail to cancel order if order does not exist', function(done) {
            api.put(ENDPOINT + '/v1/orders/' + order.id + 1 + '/cancel')
                .set('Accept', 'application/json')
                .catch(err => {
                    // check status code
                    expect(err.response.res.statusCode).to.equal(404);

                    // check error message
                    expect(err.response.res.text).to.have.string('ORDER_NOT_FOUND');

                    done();
                });
        });

        it('should fail to cancel order if order is COMPLETED', function(done) {
            api.put(ENDPOINT + '/v1/orders/' + order.id + '/take')
                .set('Accept', 'application/json')
                .then(res => {
                    // check status code
                    expect(res.statusCode).to.equal(200);

                    api.put(ENDPOINT + '/v1/orders/' + order.id + '/complete')
                        .set('Accept', 'application/json')
                        .then(res => {
                            // check status code
                            expect(res.statusCode).to.equal(200);

                            api.put(ENDPOINT + '/v1/orders/' + order.id + '/cancel')
                                .set('Accept', 'application/json')
                                .catch(err => {
                                    // check status code
                                    expect(err.response.res.statusCode).to.equal(422);

                                    // check error message
                                    expect(err.response.res.text).to.have.string('COMPLETED already');

                                    done();
                                });
                        })
                        .catch(err => {
                            console.log('error: ' + err.message);
                            console.log('max retry attempts: ' + RETRY);
                        });
                })
                .catch(err => {
                    console.log('error: ' + err.message);
                    console.log('max retry attempts: ' + RETRY);
                });
        });
    });
});