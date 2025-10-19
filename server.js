require('dotenv').config();
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const uri = process.env.MONGO_URI;

// --- [FINAL FIX] Explicitly set TLS version to 1.2 ---
const client = new MongoClient(uri, {
    tls: true,
    tlsVersion: 'TLSv1.2', // Force TLS version 1.2
});

async function run() {
    try {
        await client.connect();
        const database = client.db("CarBookingDB");
        const usersCollection = database.collection("users");
        const bookingsCollection = database.collection("bookings");
        const carsCollection = database.collection("cars");

        console.log("Successfully connected to MongoDB Atlas using TLSv1.2!");

        // --- API Endpoints ---
        
        // POST /api/login
        app.post('/api/login', async (req, res) => {
            try {
                const { email, password } = req.body;
                const user = await usersCollection.findOne({ email, password });
                if (user) {
                    const { password, ...userWithoutPassword } = user;
                    res.status(200).json({ status: 'success', user: userWithoutPassword });
                } else {
                    res.status(401).json({ status: 'error', message: "อีเมลหรือรหัสผ่านไม่ถูกต้อง" });
                }
            } catch (error) {
                console.error("Login Error:", error);
                res.status(500).json({ message: "Server error on login", error: error.toString() });
            }
        });

        // GET /api/status
        app.get('/api/status', async (req, res) => {
            try {
                const cars = await carsCollection.find({}).toArray();
                const now = new Date();
        
                const carStatuses = await Promise.all(cars.map(async (car) => {
                    const currentBooking = await bookingsCollection.findOne({
                        name: car.name,
                        status: 'approved',
                        startDateTime: { $lte: now },
                        endDateTime: { $gt: now },
                        endMileage: { $exists: false }
                    });
        
                    if (currentBooking) {
                        return { 
                            ...car,
                            status: 'กำลังใช้งาน', 
                            currentBooker: currentBooking.bookerName, 
                            bookingEndTime: new Date(currentBooking.endDateTime).toLocaleDateString('th-TH'), 
                            bookingId: currentBooking._id, 
                            startDateTime: currentBooking.startDateTime,
                            endDateTime: currentBooking.endDateTime,
                            startMileage: currentBooking.startMileage, 
                            endMileage: currentBooking.endMileage 
                        };
                    } else {
                        const nextBooking = await bookingsCollection.findOne({ 
                            name: car.name, 
                            status: 'approved',
                            startDateTime: { $gt: now }, 
                            endMileage: { $exists: false }
                        }, { sort: { startDateTime: 1 } });
                        return { 
                            ...car, 
                            status: 'ว่าง', 
                            nextBookingInfo: nextBooking ? `ว่างถึง ${new Date(nextBooking.startDateTime).toLocaleDateString('th-TH')}` : 'ไม่มีการจองถัดไป' 
                        };
                    }
                }));
                res.status(200).json({ status: 'success', data: carStatuses });
            } catch (error) {
                console.error("Status Error:", error);
                res.status(500).json({ message: "Server error on status", error: error.toString() });
            }
        });

        // GET /api/cars
        app.get('/api/cars', async (req, res) => {
             try {
                const cars = await carsCollection.find({}).toArray();
                res.status(200).json({ status: 'success', data: cars });
            } catch (error) {
                console.error("Get Cars Error:", error);
                res.status(500).json({ message: "Server error on getting cars", error: error.toString() });
            }
        });
        
        // GET /api/bookings/car/:carName
        app.get('/api/bookings/car/:carName', async (req, res) => {
             try {
                const { carName } = req.params;
                const bookings = await bookingsCollection.find({ name: carName }).sort({ startDateTime: 1 }).toArray();
                res.status(200).json({ status: 'success', data: bookings });
            } catch (error) {
                console.error("Get Car Bookings Error:", error);
                res.status(500).json({ message: "Server error on getting car bookings", error: error.toString() });
            }
        });

        // POST /api/bookings
        app.post('/api/bookings', async (req, res) => {
            try {
                const { name, bookerName, startMileage, startDateTime, endDateTime, bookerEmail } = req.body;
                const start = new Date(startDateTime);
                const end = new Date(endDateTime);

                const conflictingBooking = await bookingsCollection.findOne({
                    name: name,
                    status: 'approved',
                    endMileage: { $exists: false },
                    $or: [
                        { startDateTime: { $lt: end, $gte: start } },
                        { endDateTime: { $gt: start, $lte: end } },
                        { startDateTime: { $lte: start }, endDateTime: { $gte: end } }
                    ]
                });

                if (conflictingBooking) {
                    return res.status(409).json({ status: 'error', message: 'รถคันนี้ถูกจองแล้วในช่วงเวลาที่ท่านเลือก' });
                }

                const newBooking = { name, bookerName, bookerEmail, startMileage: parseFloat(startMileage), startDateTime: start, endDateTime: end, status: 'pending', createdAt: new Date() };
                await bookingsCollection.insertOne(newBooking);
                res.status(201).json({ status: 'success', message: 'Booking request sent for approval' });
            } catch (error) {
                console.error("Create Booking Error:", error);
                res.status(500).json({ message: "Server error on creating booking", error: error.toString() });
            }
        });
        
        // GET /api/history/:email
        app.get('/api/history/:email', async (req, res) => {
            try {
                const { email } = req.params;
                const bookings = await bookingsCollection.find({ bookerEmail: email }).sort({ startDateTime: -1 }).toArray();
                res.status(200).json({ status: 'success', data: bookings });
            } catch (error) {
                console.error("Get History Error:", error);
                res.status(500).json({ message: "Server error on getting history", error: error.toString() });
            }
        });
        
        // PATCH /api/bookings/:id/start
        app.patch('/api/bookings/:id/start', async (req, res) => {
            try {
                const { id } = req.params;
                const { actualMileage } = req.body;
                const booking = await bookingsCollection.findOne({ _id: new ObjectId(id) });
                if (!booking) return res.status(404).json({ message: "Booking not found" });

                const missingMileage = parseFloat(actualMileage) - booking.startMileage;
                
                await bookingsCollection.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: { startMileage: parseFloat(actualMileage), missingMileage: missingMileage }}
                );
                res.status(200).json({ status: 'success', message: 'Trip started'});
            } catch (error) {
                console.error("Start Trip Error:", error);
                res.status(500).json({ message: "Server error on starting trip", error: error.toString() });
            }
        });

        // PATCH /api/bookings/:id/complete
        app.patch('/api/bookings/:id/complete', async (req, res) => {
            try {
                const { id } = req.params;
                const { endMileage } = req.body;
                const booking = await bookingsCollection.findOne({ _id: new ObjectId(id) });
                if (!booking) return res.status(404).json({ message: "Booking not found" });

                const distanceTraveled = parseFloat(endMileage) - booking.startMileage;

                await bookingsCollection.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: { endMileage: parseFloat(endMileage), distanceTraveled: distanceTraveled }}
                );
                await carsCollection.updateOne({ name: booking.name }, { $set: { lastMileage: parseFloat(endMileage) }});

                res.status(200).json({ status: 'success', message: 'Trip completed'});
            } catch (error) {
                console.error("Complete Trip Error:", error);
                res.status(500).json({ message: "Server error on completing trip", error: error.toString() });
            }
        });

        // PATCH /api/bookings/:id/extend
        app.patch('/api/bookings/:id/extend', async (req, res) => {
            try {
                const { id } = req.params;
                const { newEndDateTime } = req.body;

                const bookingToEnd = await bookingsCollection.findOne({ _id: new ObjectId(id) });
                if (!bookingToEnd) {
                    return res.status(404).json({ message: "Booking not found" });
                }

                const start = new Date(bookingToEnd.endDateTime);
                const end = new Date(newEndDateTime);

                const conflictingBooking = await bookingsCollection.findOne({
                    name: bookingToEnd.name,
                    _id: { $ne: new ObjectId(id) },
                    status: 'approved',
                    endMileage: { $exists: false },
                    $or: [
                        { startDateTime: { $lt: end, $gte: start } },
                        { endDateTime: { $gt: start, $lte: end } },
                        { startDateTime: { $lte: start }, endDateTime: { $gte: end } }
                    ]
                });

                if (conflictingBooking) {
                    return res.status(409).json({ status: 'error', message: `ไม่สามารถต่อเวลาได้ เนื่องจากมีการจองต่อโดยคุณ ${conflictingBooking.bookerName}` });
                }

                await bookingsCollection.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: { endDateTime: end } }
                );
                
                res.status(200).json({ status: 'success', message: 'ต่อเวลาการจองสำเร็จ' });

            } catch (error) {
                console.error("Extend Time Error:", error);
                res.status(500).json({ message: "Server error on extending time", error: error.toString() });
            }
        });

        app.get('/', (req, res) => res.send('Car Booking Server is running!'));
        app.listen(port, () => console.log(`Server is running on http://localhost:${port}`));

    } catch (err) {
        console.error("Failed to connect to MongoDB", err);
        process.exit(1);
    }
}

run();

