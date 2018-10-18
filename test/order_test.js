var chai = require('chai'),
    should = chai.should(),
    expect = chai.expect,
    assertArrays = require('chai-arrays');
    chai.use(assertArrays),
    randomLocation = require('random-location'),
    moment = require('moment-timezone'),
    supertest = require('supertest'),
    // endpoint is default as http://localhost:51544, but can be overridden with process.env.npm_config_endpoint
    // eg. `npm --endpoint=http://localhost:51544 test`
    api = supertest(process.env.npm_config_endpoint ? process.env.npm_config_endpoint : 'http://localhost:51544');

describe('Order', function () {
    // office location - Lai Chi Kok
    const OFFICE = {
        latitude: 22.334600,
        longitude: 114.147640
    };
    // in meters
    const RADIUS = 10000;
    // tolerance for amount calculation
    const TOLERANCE = 0.01;
    // retry is default as 3, but can be overridden with process.env.npm_config_retry
    // eg. `npm --retry=1 test`
    const RETRY = process.env.npm_config_retry ? process.env.npm_config_retry : 3;
    // order status
    const STATUS = {
        ASSIGNING : "ASSIGNING",
        ONGOING: "ONGOING",
        COMPLETED: "COMPLETED",
        CANCELLED: "CANCELLED"
    };
    // api action
    const ACTION = {
        TAKE : "take",
        COMPLETE: "complete",
        CANCEL: "cancel"
    };

    // set max number of retry for each test to account for Service Unavailability
    this.retries(RETRY);

    /**
      * @desc generate a random integer within provided range
      * @param int $min - the min of the desired range
      * @param int $max - the max of the desired range
      * @return int - random integer within provided range
    **/
    function generateRandomInteger(min, max) {
        return Math.floor(min + Math.random()*(max + 1 - min))
    };

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
    };

    /**
      * @desc get corresponding action from STATUS
      * @param STATUS $status - one of the statuses
      * @return string - corresponding action
    **/
    function getActionFromStatus(status) {
        var action = ACTION.CANCEL;

        switch(status) {
            case STATUS.ONGOING:
                action = ACTION.TAKE;
                break;
            case STATUS.COMPLETED:
                action = ACTION.COMPLETE;
                break;
            case STATUS.CANCELLED:
                action = ACTION.CANCEL;
                break;
            default:
                action = ACTION.CANCEL;
        }

        return action;
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
    };

    /**
      * @desc check if fare amount is correct 
      *     introduced tolerance as amount is sometimes off by 0.01 due to rounding
      *     @TODO improve expected fare formula and remove tolerance
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

        var diffNormal = Math.abs(actualFareAmount - expectedFareAmountNormal);
        var diffSurcharge = Math.abs(actualFareAmount - expectedFareAmountSurcharge);

        if (isSurcharge == null) {
            // return true if match either amount within tolerance
            return diffNormal < TOLERANCE || diffSurcharge < TOLERANCE;
        } else if (isSurcharge) {
            // return true if match surcharge amount within tolerance
            return diffSurcharge < TOLERANCE;
        } else {
            // return true if match normal amount within tolerance
            return diffNormal < TOLERANCE;
        }
    };

    /**
      * @desc print error message for debugging
      * @param function $done - indicate test is completed (passed from higher level function)
      * @param object $err - err object that contains message
      * @return none
    **/
    function printError(done, err) {
        console.log('error: ' + err.message);
        if (err) done(err);
    };

    /**
      * @desc validate order (newly created) for each field and field type
      * @param function $done - indicate test is completed (passed from higher level function)
      * @param object $res - api response (passed from higher level function)
      * @param object $order - order object from api response
      * @param object $trip - trip object from api request payload
      * @param bool $isSurcharge - is between 5am - 9pm
      * @param STATUS $status - one of the statuses for assertion
      * @return none
    **/
    function validateCreatedOrder(done, res, order, trip, isSurcharge, status) {
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
    };

    /**
      * @desc validate order (fetched with any status) for each field and field type
      * @param function $done - indicate test is completed (passed from higher level function)
      * @param object $res - api response (passed from higher level function)
      * @param object $order - order object from api response
      * @param object $trip - trip object from api request payload
      * @param bool $isSurcharge - is between 5am - 9pm
      * @param STATUS $status - one of the statuses for assertion
      * @return none
    **/
    function validateFetchedOrder(done, res, order, trip, isSurcharge, status) {
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
        expect(checkFareAmount(parseFloat(res.body.fare.amount), totalDistance, isSurcharge)).to.be.true;
        expect(res.body.fare).to.have.property("currency").and.to.be.a('string').and.to.equal('HKD');

        // check status
        expect(res.body.status).to.be.a('string').and.to.equal(status);

        // check dateTime
        var orderDateTime = new Date(res.body.orderDateTime);
        var createdTime = new Date(res.body.createdTime);
        expect(orderDateTime >= createdTime).to.be.true;

        done();
    };

    /**
      * @desc validate order (newly taken) for each field and field type
      * @param function $done - indicate test is completed (passed from higher level function)
      * @param object $res - api response (passed from higher level function)
      * @param object $order - order object from api response
      * @param STATUS $status - one of the statuses for assertion
      * @return none
    **/
    function validateTakenOrder(done, res, order, status) {
        var expectedKeys = ['id', 'status', 'ongoingTime'];
        validateOrder(done, res, order, status, expectedKeys);
    };

    /**
      * @desc validate order (newly completed) for each field and field type
      * @param function $done - indicate test is completed (passed from higher level function)
      * @param object $res - api response (passed from higher level function)
      * @param object $order - order object from api response
      * @param STATUS $status - one of the statuses for assertion
      * @return none
    **/
    function validateCompletedOrder(done, res, order, status) {
        var expectedKeys = ['id', 'status', 'completedAt'];
        validateOrder(done, res, order, status, expectedKeys);
    };

    /**
      * @desc validate order (newly cancelled) for each field and field type
      * @param function $done - indicate test is completed (passed from higher level function)
      * @param object $res - api response (passed from higher level function)
      * @param object $order - order object from api response
      * @param STATUS $status - one of the statuses for assertion
      * @return none
    **/
    function validateCancelledOrder(done, res, order, status) {
        var expectedKeys = ['id', 'status', 'cancelledAt'];
        validateOrder(done, res, order, status, expectedKeys);
    };

    /**
      * @desc validate order (newly taken, completed, or cancelled) for each field and field type
      * @param function $done - indicate test is completed (passed from higher level function)
      * @param object $res - api response (passed from higher level function)
      * @param object $order - order object from api response
      * @param STATUS $status - one of the statuses for assertion
      * @param array $expectedKeys - attributes expected from api response
      * @return none
    **/
    function validateOrder(done, res, order, status, expectedKeys) {
        // check status code
        expect(res.statusCode).to.equal(200);

        // check all fields exist
        expect(res.body).to.have.keys(expectedKeys);

        // check id (int)
        expect(res.body.id).to.be.a('number').and.to.equal(order.id);

        // check status
        expect(res.body.status).to.be.a('string').and.to.equal(status);

        done();
    };

    /**
      * @desc make api call to create order and validate
      * @param function $done - indicate test is completed (passed from higher level function)
      * @param object $trip - trip object from api request payload
      * @param bool $isSurcharge - is between 5am - 9pm
      * @param function $validate - validation function to use
      * @return none
    **/
    function createOrderAndValidate(done, trip, isSurcharge, validate) {
        api.post('/v1/orders')
            .set('Accept', 'application/json')
            .send(trip)
            .then(res => {
                var order = res.body;
                var status = "ASSIGNING";
                validate(done, res, order, trip, isSurcharge, status);
            })
            .catch(err => {
                printError(done, err);
            });
    };

    /**
      * @desc make api call to create order and expect error
      * @param function $done - indicate test is completed (passed from higher level function)
      * @param object $trip - trip object from api request payload
      * @param int $expectedStatusCode - expected status code
      * @param string $expectedErrorMessage - expected error message
      * @return none
    **/
    function createOrderAndExpectError(done, trip, expectedStatusCode, expectedErrorMessage) {
        api.post('/v1/orders')
            .set('Accept', 'application/json')
            .send(trip)
            .ok(res => res.status == expectedStatusCode)
            .then(res => {
                // check status code
                expect(res.statusCode).to.equal(expectedStatusCode);

                // check error message
                if (expectedErrorMessage) {
                    expect(res.body.message).to.have.string(expectedErrorMessage);
                }

                done();
            })
            .catch(err => {
                printError(done, err);
            });
    };

    /**
      * @desc make api call to put order (take, complete, or cancel) and expect error
      * @param function $done - indicate test is completed (passed from higher level function)
      * @param object $order - order object return from api response
      * @param ACTION $action - one of the actions for available
      * @param int $expectedStatusCode - expected status code
      * @param string $expectedErrorMessage - expected error message
      * @return none
    **/
    function putOrderAndExpectError(done, order, action, expectedStatusCode, expectedErrorMessage) {
        api.put('/v1/orders/' + order.id + '/' + action)
            .ok(res => res.status == expectedStatusCode)
            .then(res => {
                // check status code
                expect(res.statusCode).to.equal(expectedStatusCode);

                // check error message
                if (expectedErrorMessage) {
                    expect(res.body.message).to.have.string(expectedErrorMessage);
                }

                done();
            })
            .catch(err => {
                printError(done, err);
            });
    }

    /**
      * @desc make api call to fetch order and validate
      * @param function $done - indicate test is completed (passed from higher level function)
      * @param object $order - order object from api response
      * @param object $trip - trip object from api request payload
      * @param bool $isSurcharge - is between 5am - 9pm
      * @param STATUS $status - one of the statuses for assertion
      * @param function $validate - validation function to use
      * @return none
    **/
    function fetchOrderAndValidate(done, order, trip, isSurcharge, status, validate) {
        api.get('/v1/orders/' + order.id)
            .then(res => {
                validate(done, res, order, trip, isSurcharge, status);
            })
            .catch(err => {
                printError(done, err);
            });
    };

    /**
      * @desc make api call to take order and validate
      * @param function $done - indicate test is completed (passed from higher level function)
      * @param object $order - order object from api response
      * @param function $validate - validation function to use
      * @return none
    **/
    function takeOrderAndValidate(done, order, validate) {
        var status = STATUS.ONGOING;
        putOrder(done, order, status, validate);
    };

    /**
      * @desc make api call to complete order and validate
      * @param function $done - indicate test is completed (passed from higher level function)
      * @param object $order - order object from api response
      * @param function $validate - validation function to use
      * @return none
    **/
    function completeOrderAndValidate(done, order, validate) {
        var status = STATUS.COMPLETED;
        putOrder(done, order, status, validate);
    };

    /**
      * @desc make api call to cancel order and validate
      * @param function $done - indicate test is completed (passed from higher level function)
      * @param object $order - order object from api response
      * @param function $validate - validation function to use
      * @return none
    **/
    function cancelOrderAndValidate(done, order, validate) {
        var status = STATUS.CANCELLED;
        putOrder(done, order, status, validate);
    };

    /**
      * @desc make api call to put order (take, complete, or cancel) and validate
      * @param function $done - indicate test is completed (passed from higher level function)
      * @param object $order - order object from api response
      * @param STATUS $status - one of the statuses for assertion
      * @param function $validate - validation function to use
      * @return none
    **/
    function putOrder(done, order, status, validate) {
        var action = getActionFromStatus(status);

        api.put('/v1/orders/' + order.id + '/' + action)
            .set('Accept', 'application/json')
            .then(res => {
                validate(done, res, order, status);
            })
            .catch(err => {
                printError(done, err);
            });
    }

    /**
      * Test suite for creating orders
    **/
    describe('POST /v1/orders', function () {
        it('should create order successfully with orderAt and return correct fields and types', function(done) {
            var isSurcharge = false;
            var trip = prepareTrip(null, isSurcharge);

            createOrderAndValidate(done, trip, isSurcharge, validateCreatedOrder);
        });

        it('should create order successfully without orderAt', function(done) {
            var isSurcharge = null;
            var trip = prepareTrip(null, isSurcharge);

            createOrderAndValidate(done, trip, isSurcharge, validateCreatedOrder);
        });

        it('should create order successfully with more than 10 stops', function(done) {
            var isSurcharge = false;
            var trip = prepareTrip(generateRandomInteger(11,20), isSurcharge);

            createOrderAndValidate(done, trip, isSurcharge, validateCreatedOrder);
        });

        it('should create order successfully with correct fare between 5am to 9pm', function(done) {
            var isSurcharge = false;
            var trip = prepareTrip(null, isSurcharge);

            createOrderAndValidate(done, trip, isSurcharge, validateCreatedOrder);
        });

        it('should create order successfully with correct fare between 9pm to 5am', function(done) {
            var isSurcharge = true;
            var trip = prepareTrip(null, isSurcharge);

            createOrderAndValidate(done, trip, isSurcharge, validateCreatedOrder);
        });

        it('should fail to create order if only one stop', function(done) {
            var trip = prepareTrip(0, null);
            var expectedStatusCode = 400;
            var expectedErrorMessage = 'error in field(s): stops';

            createOrderAndExpectError(done, trip, expectedStatusCode, expectedErrorMessage);
        });

        it('should fail to create order if lat/lng is invalid', function(done) {
            var invalidLatLng = {
                latitude: 22.334600,
                longitude: 115.147640
            };

            var trip = prepareTrip(null, null, invalidLatLng);
            var expectedStatusCode = 503;
            var expectedErrorMessage = 'Service Unavailable';

            createOrderAndExpectError(done, trip, expectedStatusCode, expectedErrorMessage);
        });

        it('should fail to create order if payload is missing', function(done) {
            var trip = '';
            var expectedStatusCode = 400;
            var expectedErrorMessage = '';

            createOrderAndExpectError(done, trip, expectedStatusCode, expectedErrorMessage);
        });
    });

    /**
      * Test suite for fetching orders
    **/
    describe('GET /v1/orders/{orderID}', function () {
        var trip = prepareTrip(null, null);
        var isSurcharge = null;

        it('should fetch order details successfully if order is ASSIGNING and return correct fields and types', function(done) {
            createOrderAndValidate(done, trip, isSurcharge, function(done, res, order, trip, isSurcharge, status) {
                fetchOrderAndValidate(done, order, trip, isSurcharge, status, validateFetchedOrder)
            });
        });

        it('should fetch order details successfully if order is ONGOING and return correct fields and types', function(done) {
            createOrderAndValidate(done, trip, isSurcharge, function(done, res, order, trip, isSurcharge, status) {
                takeOrderAndValidate(done, order, function(done, res, order, status){
                    fetchOrderAndValidate(done, order, trip, isSurcharge, status, validateFetchedOrder);
                });
            });
        });

        it('should fetch order details successfully if order is CANCELLED and return correct fields and types', function(done) {
            createOrderAndValidate(done, trip, isSurcharge, function(done, res, order, trip, isSurcharge, status) {
                cancelOrderAndValidate(done, order, function(done, res, order, status){
                    fetchOrderAndValidate(done, order, trip, isSurcharge, status, validateFetchedOrder);
                });
            });
        });

        it('should fetch order details successfully if order is COMPLETED and return correct fields and types', function(done) {
            createOrderAndValidate(done, trip, isSurcharge, function(done, res, order, trip, isSurcharge, status) {
                takeOrderAndValidate(done, order, function(done, res, order, status){
                    completeOrderAndValidate(done, order, function(done, res, order, status){
                        fetchOrderAndValidate(done, order, trip, isSurcharge, status, validateFetchedOrder);
                    });
                });
            });
        });

        it('should fail to fetch order if order does not exist', function(done) {
            createOrderAndValidate(done, trip, isSurcharge, function(done, res, order, trip, isSurcharge, status) {
                api.get('/v1/orders/' + order.id + 1)
                    .ok(res => res.status == 404)
                    .then(res => {
                        // check status code
                        expect(res.statusCode).to.equal(404);

                        done();
                    })
                    .catch(err => {
                        printError(done, err);
                    });
            });
        });
    });

    /**
      * Test suite for taking orders
    **/
    describe('PUT /v1/orders/{orderID}/take', function () {
        var trip = prepareTrip(null, null);
        var isSurcharge = null;
        var expectedStatusCode = 422;
        var expectedErrorMessage = 'not ASSIGNING';
        var action = ACTION.TAKE;

        it('should take order successfully if order is ASSIGNING and return correct fields and types', function(done) {
            createOrderAndValidate(done, trip, isSurcharge, function(done, res, order, trip, isSurcharge, status) {
                takeOrderAndValidate(done, order, validateTakenOrder);
            });
        });

        it('should fail to take order if order is already ONGOING', function(done) {
            createOrderAndValidate(done, trip, isSurcharge, function(done, res, order, trip, isSurcharge, status) {
                takeOrderAndValidate(done, order, function(done, res, order, status) {
                    putOrderAndExpectError(done, order, action, expectedStatusCode, expectedErrorMessage);
                });
            });
        });

        it('should fail to take order if order is CANCELLED', function(done) {
            createOrderAndValidate(done, trip, isSurcharge, function(done, res, order, trip, isSurcharge, status) {
                cancelOrderAndValidate(done, order, function(done, res, order, status) {
                    putOrderAndExpectError(done, order, action, expectedStatusCode, expectedErrorMessage);
                });
            });
        });

        it('should fail to take order if order is COMPLETED', function(done) {
            createOrderAndValidate(done, trip, isSurcharge, function(done, res, order, trip, isSurcharge, status) {
                takeOrderAndValidate(done, order, function(done, res, order, status){
                    completeOrderAndValidate(done, order, function(done, res, order, status){
                        putOrderAndExpectError(done, order, action, expectedStatusCode, expectedErrorMessage);
                    });
                });
            });
        });

        it('should fail to take order if order does not exist', function(done) {
            createOrderAndValidate(done, trip, isSurcharge, function(done, res, order, trip, isSurcharge, status) {
                order.id += 1;
                var expectedStatusCode = 404;
                var expectedErrorMessage = 'ORDER_NOT_FOUND';

                putOrderAndExpectError(done, order, action, expectedStatusCode, expectedErrorMessage);
            });
        });
    });

    /**
      * Test suite for completing orders
    **/
    describe('PUT /v1/orders/{orderID}/complete', function () {
        var trip = prepareTrip(null, null);
        var isSurcharge = null;
        var expectedStatusCode = 422;
        var expectedErrorMessage = 'not ONGOING';
        var action = ACTION.COMPLETE;

        it('should complete order successfully if order is ONGOING and return correct fields and types', function(done) {
            createOrderAndValidate(done, trip, isSurcharge, function(done, res, order, trip, isSurcharge, status) {
                takeOrderAndValidate(done, order, function(done, res, order, status){
                    completeOrderAndValidate(done, order, validateCompletedOrder);
                });
            });
        });

        it('should fail to complete order if order is ASSIGNING', function(done) {
            createOrderAndValidate(done, trip, isSurcharge, function(done, res, order, trip, isSurcharge, status) {
                putOrderAndExpectError(done, order, action, expectedStatusCode, expectedErrorMessage);
            });
        });

        it('should fail to complete order if order is CANCELLED', function(done) {
            createOrderAndValidate(done, trip, isSurcharge, function(done, res, order, trip, isSurcharge, status) {
                cancelOrderAndValidate(done, order, function(done, res, order, status){
                    putOrderAndExpectError(done, order, action, expectedStatusCode, expectedErrorMessage);
                });
            });
        });

        it('should fail to complete order if order is already COMPLETED', function(done) {
            createOrderAndValidate(done, trip, isSurcharge, function(done, res, order, trip, isSurcharge, status) {
                takeOrderAndValidate(done, order, function(done, res, order, status){
                    completeOrderAndValidate(done, order, function(done, res, order, status){
                        putOrderAndExpectError(done, order, action, expectedStatusCode, expectedErrorMessage);
                    });
                });
            });
        });

        it('should fail to complete order if order does not exist', function(done) {
            createOrderAndValidate(done, trip, isSurcharge, function(done, res, order, trip, isSurcharge, status) {
                order.id += 1;
                var expectedStatusCode = 404;
                var expectedErrorMessage = 'ORDER_NOT_FOUND';

                putOrderAndExpectError(done, order, action, expectedStatusCode, expectedErrorMessage);
            });
        });
    });

    /**
      * Test suite for cancelling orders
    **/
    describe('PUT /v1/orders/{orderID}/cancel', function () {
        var trip = prepareTrip(null, null);
        var isSurcharge = null;
        var action = ACTION.CANCEL;

        it('should cancel order successfully if order is ASSIGNING and return correct fields and types', function(done) {
            createOrderAndValidate(done, trip, isSurcharge, function(done, res, order, trip, isSurcharge, status) {
                cancelOrderAndValidate(done, order, validateCancelledOrder);
            });
        });

        it('should cancel order successfully if order is ONGOING', function(done) {
            createOrderAndValidate(done, trip, isSurcharge, function(done, res, order, trip, isSurcharge, status) {
                takeOrderAndValidate(done, order, function(done, res, order, status){
                    cancelOrderAndValidate(done, order, validateCancelledOrder);
                });
            });
        });

        it('should cancel order successfully if order is already CANCELLED', function(done) {
            createOrderAndValidate(done, trip, isSurcharge, function(done, res, order, trip, isSurcharge, status) {
                cancelOrderAndValidate(done, order, function(done, res, order, status){
                    cancelOrderAndValidate(done, order, validateCancelledOrder);
                });
            });
        });

        it('should fail to cancel order if order does not exist', function(done) {
            createOrderAndValidate(done, trip, isSurcharge, function(done, res, order, trip, isSurcharge, status) {
                order.id += 1;
                var expectedStatusCode = 404;
                var expectedErrorMessage = 'ORDER_NOT_FOUND';

                putOrderAndExpectError(done, order, action, expectedStatusCode, expectedErrorMessage);
            });
        });

        it('should fail to cancel order if order is COMPLETED', function(done) {
            createOrderAndValidate(done, trip, isSurcharge, function(done, res, order, trip, isSurcharge, status) {
                takeOrderAndValidate(done, order, function(done, res, order, status){
                    completeOrderAndValidate(done, order, function(done, res, order, status){
                        var expectedStatusCode = 422;
                        var expectedErrorMessage = 'COMPLETED already';

                        putOrderAndExpectError(done, order, action, expectedStatusCode, expectedErrorMessage);
                    });
                });
            });
        });
    });
});