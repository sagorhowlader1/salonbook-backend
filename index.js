import express from 'express';
import cors from 'cors';
import 'dotenv/config'
import { MongoClient, ObjectId } from 'mongodb';
import Stripe from 'stripe';


const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

import multer from "multer"
import path from "path"
import fs from "fs"


const app = express();
const port = 5000;


// middeware
app.use(cors());
app.use(express.json());


const client = new MongoClient(process.env.MONGODB_URI);


export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
  }
}


const mongoClient = await connectToMongoDB();
const db = mongoClient.db("salonbook");
const servicesCollection = db.collection("services");
const usersCollection = db.collection("users");

const appointmentsCollection = db.collection("appointments")
const transactionsCollection = db.collection("transactions")
const paymentsCollection = db.collection("payments")



await appointmentsCollection.createIndex(
  { activeSlotKey: 1 },
  { unique: true, sparse: true }
);



// Helper: Validate MongoDB ObjectId
const isValidId = (id) => ObjectId.isValid(id);

// Helper: Check authenticated customer
const requireCustomer = (req, res, next) => {
  const customerId = req.headers["x-customer-id"];

  if (!customerId) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized. Please login first.",
    });
  }

  req.customerId = customerId;
  next();
};


// Verify requests coming from our Next.js server
const verifyInternalRequest = (req, res, next) => {
  const secret = process.env.INTERNAL_API_SECRET;

  if (
    !secret ||
    req.headers["x-internal-api-secret"] !== secret
  ) {
    return res.status(403).json({
      success: false,
      message: "Forbidden: Invalid internal request.",
    });
  }

  next();
};


// POST: Create Customer Appointment
app.post(
  "/appointments",
  verifyInternalRequest,
  requireCustomer,
  async (req, res) => {
    try {
      const {
        serviceId,
        appointmentDate,
        timeSlot,
        message,
      } = req.body;

      // 1. Validate required fields
      if (!serviceId || !appointmentDate || !timeSlot) {
        return res.status(400).json({
          success: false,
          message: "Service, appointment date and time slot are required.",
        });
      }

      // 2. Validate Service ID
      if (!ObjectId.isValid(serviceId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid service ID.",
        });
      }

      // 3. Validate appointment date
      if (!/^\d{4}-\d{2}-\d{2}$/.test(appointmentDate)) {
        return res.status(400).json({
          success: false,
          message: "Invalid appointment date.",
        });
      }

      const selectedDate = new Date(`${appointmentDate}T00:00:00`);
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      if (
        Number.isNaN(selectedDate.getTime()) ||
        selectedDate < today
      ) {
        return res.status(400).json({
          success: false,
          message: "Please select a valid future date.",
        });
      }

      // 4. Validate time slot
      const allowedTimeSlots = [
        "09:00 AM - 10:00 AM",
        "10:00 AM - 11:00 AM",
        "11:00 AM - 12:00 PM",
        "02:00 PM - 03:00 PM",
        "03:00 PM - 04:00 PM",
        "04:00 PM - 05:00 PM",
      ];

      if (!allowedTimeSlots.includes(timeSlot)) {
        return res.status(400).json({
          success: false,
          message: "Invalid appointment time slot.",
        });
      }

      // 5. Check service availability
      const service = await servicesCollection.findOne({
        _id: new ObjectId(serviceId),
        status: "Active",
      });

      if (!service) {
        return res.status(400).json({
          success: false,
          message: "This service is currently unavailable.",
        });
      }

      // 6. Prevent duplicate active appointments
      const existingAppointment =
        await appointmentsCollection.findOne({
          appointmentDate,
          timeSlot,
          appointmentStatus: {
            $in: ["Pending", "Confirmed"],
          },
        });

      if (existingAppointment) {
        return res.status(409).json({
          success: false,
          message: "This date and time slot is already booked.",
        });
      }

      // 7. Create appointment
      const appointmentData = {
        customerId: req.customerId,
        serviceId,
        serviceName: service.name,
        serviceImage: service.image || "",
        serviceCategory: service.category || "",
        servicePrice: Number(service.price) || 0,
        serviceDuration: Number(service.duration) || 0,

        appointmentDate,
        timeSlot,
        message: message?.trim() || "",

        appointmentStatus: "Pending",
        paymentStatus: "Unpaid",

        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = await appointmentsCollection.insertOne(
        appointmentData
      );

      res.status(201).json({
        success: true,
        message: "Appointment booked successfully!",
        data: {
          ...appointmentData,
          _id: result.insertedId,
        },
      });
    } catch (error) {
      console.error("Create Appointment Backend Error:", error);

      res.status(500).json({
        success: false,
        message: "Failed to create appointment.",
      });
    }
  }
);



// GET: Customer's Own Appointments

app.get(
  "/appointments/my",
  verifyInternalRequest,
  requireCustomer,
  async (req, res) => {
    try {
      const appointments = await appointmentsCollection
        .find({
          customerId: req.customerId,
        })
        .sort({ createdAt: -1 })
        .toArray();

      const result = await Promise.all(
        appointments.map(getAppointmentWithService)
      );

      res.status(200).json({
        success: true,
        message: "Appointments fetched successfully",
        data: result,
      });
    } catch (error) {

      res.status(500).json({
        success: false,
        message: "Failed to fetch appointments",
      });
    }
  }
);


// GET: Single Appointment Details

app.get(
  "/appointments/:id",
  verifyInternalRequest,
  requireCustomer,
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!isValidId(id)) {
        return res.status(400).json({
          success: false,
          message: "Invalid appointment ID",
        });
      }

      const appointment = await appointmentsCollection.findOne({
        _id: new ObjectId(id),
        customerId: req.customerId,
      });

      if (!appointment) {
        return res.status(404).json({
          success: false,
          message: "Appointment not found",
        });
      }

      const result = await getAppointmentWithService(appointment);

      res.status(200).json({
        success: true,
        message: "Appointment details fetched successfully",
        data: result,
      });
    } catch (error) {

      res.status(500).json({
        success: false,
        message: "Failed to fetch appointment details",
      });
    }
  }
);



app.get(
  "/admin/appointments",
  verifyInternalRequest,
  async (req, res) => {
    try {
      // 1. Get all appointments (latest first)
      const appointments = await appointmentsCollection
        .find({})
        .sort({ createdAt: -1 })
        .toArray();

      // 2. Attach customer information
      const allAppointments = await Promise.all(
        appointments.map(async (appointment) => {
          let customer = null;

          if (
            appointment.customerId &&
            ObjectId.isValid(appointment.customerId)
          ) {
            customer = await usersCollection.findOne(
              {
                _id: new ObjectId(appointment.customerId),
              },
              {
                projection: {
                  name: 1,
                  email: 1,
                },
              }
            );
          }

          return {
            _id: appointment._id,
            
            customer: {
              name: customer?.name || "Unknown Customer",
              email: customer?.email || "N/A",
            },

            service: {
              id: appointment.serviceId,
              name: appointment.serviceName,
              category: appointment.serviceCategory || "",
              image: appointment.serviceImage || "",
              price: appointment.servicePrice,
              duration: appointment.serviceDuration,
            },

            appointmentDate: appointment.appointmentDate,
            timeSlot: appointment.timeSlot,
            message: appointment.message || "",

            appointmentStatus: appointment.appointmentStatus,
            paymentStatus: appointment.paymentStatus,

            createdAt: appointment.createdAt,
            updatedAt: appointment.updatedAt,
          };
        })
      );

      return res.status(200).json({
        success: true,
        message: "All appointments fetched successfully.",
        total: allAppointments.length,
        data: allAppointments,
      });

    } catch (error) {
      console.error("Admin Appointments Error:", error);

      return res.status(500).json({
        success: false,
        message: "Failed to fetch appointments.",
      });
    }
  }
);




app.get(
  "/admin/dashboard/stats",
  verifyInternalRequest,
  async (req, res) => {
    try {
      // 1. Total registered customers
      const totalCustomers = await usersCollection.countDocuments({
        role: "customer",
      });

      // 2. Total active services
      const totalActiveServices = await servicesCollection.countDocuments({
        status: "Active",
      });

      // 3. Total appointment requests
      const totalAppointments =
        await appointmentsCollection.countDocuments({});

      // 4. Pending appointments
      const pendingAppointments =
        await appointmentsCollection.countDocuments({
          appointmentStatus: "Pending",
        });

      // 5. Confirmed appointments
      const confirmedAppointments =
        await appointmentsCollection.countDocuments({
          appointmentStatus: "Confirmed",
        });

      // 6. Total successful payments
      const totalSuccessfulPayments =
        await paymentsCollection.countDocuments({
          payment_status: "paid",
        });

      return res.status(200).json({
        success: true,
        data: {
          totalCustomers,
          totalActiveServices,
          totalAppointments,
          pendingAppointments,
          confirmedAppointments,
          totalSuccessfulPayments,
        },
      });
    } catch (error) {
      console.error("Admin Dashboard Stats Error:", error);

      return res.status(500).json({
        success: false,
        message: "Failed to fetch dashboard statistics.",
      });
    }
  }
);





app.patch(
  "/admin/appointments/:id/status",
  verifyInternalRequest,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { status } = req.body;

      // 1. Validate appointment ID
      if (!ObjectId.isValid(id)) {
        return res.status(400).json({
          success: false,
          message: "Invalid appointment ID.",
        });
      }

      // 2. Validate requested status
      if (!["Confirmed", "Cancelled"].includes(status)) {
        return res.status(400).json({
          success: false,
          message: "Invalid appointment status.",
        });
      }

      // 3. Find appointment
      const appointment = await appointmentsCollection.findOne({
        _id: new ObjectId(id),
      });

      if (!appointment) {
        return res.status(404).json({
          success: false,
          message: "Appointment not found.",
        });
      }

      // 4. Confirm only Pending appointments
      if (
        status === "Confirmed" &&
        appointment.appointmentStatus !== "Pending"
      ) {
        return res.status(400).json({
          success: false,
          message: "Only pending appointments can be confirmed.",
        });
      }

      // 5. Cancel Pending or Confirmed appointments
      if (
        status === "Cancelled" &&
        !["Pending", "Confirmed"].includes(
          appointment.appointmentStatus
        )
      ) {
        return res.status(400).json({
          success: false,
          message: "Only pending or confirmed appointments can be cancelled.",
        });
      }

      // 6. Update appointment status
      const result = await appointmentsCollection.updateOne(
        {
          _id: new ObjectId(id),
          appointmentStatus: appointment.appointmentStatus,
        },
        {
          $set: {
            appointmentStatus: status,
            updatedAt: new Date(),
          },
        }
      );

      if (result.modifiedCount === 0) {
        return res.status(409).json({
          success: false,
          message: "Appointment status has already changed. Please refresh.",
        });
      }

      return res.status(200).json({
        success: true,
        message: `Appointment ${status.toLowerCase()} successfully.`,
        data: {
          _id: id,
          appointmentStatus: status,
          paymentStatus: appointment.paymentStatus,
        },
      });

    } catch (error) {
      console.error("Update Appointment Status Error:", error);

      return res.status(500).json({
        success: false,
        message: "Failed to update appointment status.",
      });
    }
  }
);



// PATCH: Cancel Pending Appointment

app.patch(
  "/appointments/:id/cancel",
  verifyInternalRequest,
  requireCustomer,
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!isValidId(id)) {
        return res.status(400).json({
          success: false,
          message: "Invalid appointment ID",
        });
      }

      const result = await appointmentsCollection.updateOne(
        {
          _id: new ObjectId(id),
          customerId: req.customerId,
          appointmentStatus: "Pending",
        },
        {
          $set: {
            appointmentStatus: "Cancelled",
            updatedAt: new Date(),
          },
        }
      );

      if (result.matchedCount === 0) {
        const appointment = await appointmentsCollection.findOne({
          _id: new ObjectId(id),
          customerId: req.customerId,
        });

        if (!appointment) {
          return res.status(404).json({
            success: false,
            message: "Appointment not found",
          });
        }

        return res.status(400).json({
          success: false,
          message:
            "Only pending appointments can be cancelled.",
        });
      }

      res.status(200).json({
        success: true,
        message: "Appointment cancelled successfully",
      });
    } catch (error) {

      res.status(500).json({
        success: false,
        message: "Failed to cancel appointment",
      });
    }
  }
);



// Get all active services
app.get("/service", async (req, res) => {
  try {
    const result = await servicesCollection
      .find({ status: "Active" })
      .toArray();

    res.send(result);
  } catch (error) {
    res.status(500).send({
      message: "Failed to fetch services",
    });
  }
});


// Get featured services (only 6)
app.get("/featured-services", async (req, res) => {
  try {
    const result = await servicesCollection
      .find({ status: "Active" })
      .limit(6)
      .toArray();

    res.send(result);
  } catch (error) {
    res.status(500).send({
      message: "Failed to fetch featured services",
    });
  }
});



// Helper: Get appointment with service information
const getAppointmentWithService = async (appointment) => {
  let service = null;

  if (isValidId(appointment.serviceId)) {
    service = await servicesCollection.findOne({
      _id: new ObjectId(appointment.serviceId),
    });
  }

  return {
    ...appointment,

    serviceName:
      appointment.serviceName || service?.name || "Unknown Service",

    serviceImage:
      appointment.serviceImage || service?.image || "",

    serviceCategory:
      appointment.serviceCategory || service?.category || "",

    servicePrice:
      appointment.servicePrice ?? service?.price ?? 0,
  };
};



// Multer configuration
const storage = multer.memoryStorage()

const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5 MB
  },
})



const uploadToImgBB = async (file) => {
  if (!process.env.IMGBB_API_KEY) {
    throw new Error("IMGBB_API_KEY is missing")
  }

  const formData = new FormData()

  formData.append(
    "image",
    file.buffer.toString("base64")
  )

  const response = await fetch(
    `https://api.imgbb.com/1/upload?key=${process.env.IMGBB_API_KEY}`,
    {
      method: "POST",
      body: formData,
    }
  )

  const result = await response.json()

  if (!response.ok || !result.success) {
    throw new Error(
      result.error?.message || "ImgBB upload failed"
    )
  }

  return result.data.url
}



// Create service
app.post("/service", upload.single("imageFile"), async (req, res) => {
  try {
    let imageUrl = ""

    // Upload image to ImgBB
    if (req.file) {
      imageUrl = await uploadToImgBB(req.file)
    }

    const serviceData = {
      name: req.body.name,
      category: req.body.category,
      description: req.body.description,
      price: Number(req.body.price),
      duration: Number(req.body.duration),
      status: req.body.status,
      image: imageUrl,
    }

    const result = await servicesCollection.insertOne(serviceData)

    res.status(201).send({
      success: true,
      message: "Service created successfully",
      insertedId: result.insertedId,
      service: {
        ...serviceData,
        _id: result.insertedId,
      },
    })
  } catch (error) {
    console.error("Service creation error:", error)

    res.status(500).send({
      success: false,
      message: error.message || "Service creation failed",
    })
  }
})




// DELETE SERVICE
app.delete("/service/:id", async (req, res) => {
  try {
    const { id } = req.params

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: "Invalid service ID" })
    }

    const service = await servicesCollection.findOne({
      _id: new ObjectId(id),
    })

    if (!service) {
      return res.status(404).send({ message: "Service not found" })
    }

    const result = await servicesCollection.deleteOne({
      _id: new ObjectId(id),
    })

    // Delete uploaded image from uploads folder
    if (service.image?.startsWith("/uploads/")) {
      const filename = path.basename(service.image)
      const imagePath = path.join(process.cwd(), "uploads", filename)

      if (fs.existsSync(imagePath)) {
        fs.unlinkSync(imagePath)
      }
    }

    res.send({
      message: "Service deleted successfully",
      deletedCount: result.deletedCount,
    })
  } catch (error) {
    console.error("Delete service error:", error)
    res.status(500).send({ message: "Failed to delete service" })
  }
})

// UPDATE SERVICE

app.put("/service/:id", upload.single("imageFile"), async (req, res) => {
  try {
    const { id } = req.params

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid service ID",
      })
    }

    const existingService = await servicesCollection.findOne({
      _id: new ObjectId(id),
    })

    if (!existingService) {
      return res.status(404).json({
        success: false,
        message: "Service not found",
      })
    }

    // Keep old image unless a new image is uploaded
    let imageUrl = existingService.image || ""

    if (req.file) {
      imageUrl = await uploadToImgBB(req.file)
    }

    const updatedService = {
      name: req.body.name,
      category: req.body.category,
      description: req.body.description,
      price: Number(req.body.price),
      duration: Number(req.body.duration),
      status: req.body.status,
      image: imageUrl,
    }

    const result = await servicesCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: updatedService }
    )

    res.status(200).json({
      success: true,
      message: "Service updated successfully",
      modifiedCount: result.modifiedCount,
      service: {
        _id: id,
        ...updatedService,
      },
    })
  } catch (error) {
    console.error("Update service error:", error)

    res.status(500).json({
      success: false,
      message: error.message || "Failed to update service",
    })
  }
})



app.get("/service/:id", async (req, res) => {
  try {
    const { id } = req.params

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        message: "Invalid service ID",
      })
    }

    const service = await servicesCollection.findOne({
      _id: new ObjectId(id),
    })

    if (!service) {
      return res.status(404).send({
        message: "Service not found",
      })
    }

    res.send(service)
  } catch (error) {
    console.error("Get service error:", error)

    res.status(500).send({
      message: "Failed to fetch service",
    })
  }
})




app.post('/payments/chechout-verify', async (req, res) => {
  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).send({
        success: false,
        message: 'Session ID is required!',
      });
    }

    // 1. Retrieve Stripe Checkout Session
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    const {
      status,
      payment_status,
      customer_email,
      metadata,
      payment_intent,
      amount_total,
      currency,
    } = session;

    if (status !== 'complete' || payment_status !== 'paid') {
      return res.status(400).send({
        success: false,
        message: 'Payment verification failed!',
      });
    }

    // 2. Appointment Payment Verification
    if (metadata?.appointmentId) {
      const appointmentId = metadata.appointmentId;
      const userId = metadata.userId;

      if (
        !ObjectId.isValid(appointmentId) ||
        !ObjectId.isValid(userId)
      ) {
        return res.status(400).send({
          success: false,
          message: 'Invalid appointment or user ID.',
        });
      }

      const appointmentQuery = {
        _id: new ObjectId(appointmentId),
        customerId: userId,
      };

      const appointment = await appointmentsCollection.findOne(
        appointmentQuery
      );

      if (!appointment) {
        return res.status(404).send({
          success: false,
          message: 'Appointment not found.',
        });
      }

      // Verify payment amount
      const expectedAmount = Math.round(
        Number(appointment.servicePrice) * 100
      );

      if (
        amount_total !== expectedAmount ||
        currency !== 'usd'
      ) {
        return res.status(400).send({
          success: false,
          message: 'Payment amount verification failed.',
        });
      }

      const existingPayment = await paymentsCollection.findOne({
        sessionId,
      });

      if (existingPayment) {
        if (
          appointment.paymentStatus === 'Paid' &&
          appointment.appointmentStatus === 'Confirmed'
        ) {
          return res.send({
            success: true,
            message: 'Appointment payment already verified.',
          });
        }

        return res.status(409).send({
          success: false,
          message: 'Payment record already exists.',
        });
      }

      // Update appointment status
      const updateResult = await appointmentsCollection.updateOne(
        {
          ...appointmentQuery,
          paymentStatus: 'Unpaid',
        },
        {
          $set: {
            paymentStatus: 'Paid',
            appointmentStatus: 'Confirmed',
            updatedAt: new Date(),
          },
        }
      );

      if (updateResult.modifiedCount !== 1) {
        return res.status(409).send({
          success: false,
          message: 'Appointment could not be updated.',
        });
      }

      // Save payment record
      await transactionsCollection.insertOne({
        sessionId,
        status,
        payment_status,
        customer_email,
        userId,
        appointmentId,
        payment_intent,
        amount_total,
        currency,
        createdAt: new Date(),
      });

      return res.send({
        success: true,
        message: 'Appointment payment verified successfully!',
      });
    }

    // 3. Existing Premium Payment Verification
    const existingPayment = await paymentsCollection.findOne({
      sessionId,
    });

    if (existingPayment) {
      return res.send({
        success: false,
        message: 'Payment already verified.',
      });
    }

    if (!metadata?.userId || !ObjectId.isValid(metadata.userId)) {
      return res.status(400).send({
        success: false,
        message: 'Invalid user ID.',
      });
    }

    const payment = {
      sessionId,
      status,
      payment_status,
      customer_email,
      userId: metadata.userId,
      payment_intent,
    };

    const result = await paymentsCollection.insertOne(payment);

    const updateResult = await usersCollection.updateOne(
      { _id: new ObjectId(metadata.userId) },
      {
        $set: {
          premium: true,
        },
      }
    );

    return res.send({
      success: true,
      result,
      updateResult,
    });

  } catch (error) {
    return res.status(500).send({
      success: false,
      message: 'Payment verification failed.',
    });
  }
});



// Admin Transactions API
app.get(
  "/admin/transactions",
  verifyInternalRequest,
  async (req, res) => {
    try {
      const payments = await paymentsCollection
        .find({})
        .sort({ createdAt: -1 })
        .toArray();

      const transactions = await Promise.all(
        payments.map(async (payment) => {
          let customer = null;
          let appointment = null;

          if (payment.userId && ObjectId.isValid(payment.userId)) {
            customer = await usersCollection.findOne(
              { _id: new ObjectId(payment.userId) },
              { projection: { name: 1, email: 1 } }
            );
          }

          if (
            payment.appointmentId &&
            ObjectId.isValid(payment.appointmentId)
          ) {
            appointment = await appointmentsCollection.findOne({
              _id: new ObjectId(payment.appointmentId),
            });
          }

          return {
            _id: payment._id,
            customerName: customer?.name || "Unknown Customer",
            customerEmail:
              customer?.email || payment.customer_email || "N/A",

            serviceName: appointment?.serviceName || "Premium Payment",
            appointmentDate: appointment?.appointmentDate || "N/A",

            amount: payment.amount_total
              ? payment.amount_total / 100
              : null,

            currency: payment.currency?.toUpperCase() || "N/A",

            sessionId: payment.sessionId || "N/A",

            paymentStatus: payment.payment_status || "Unknown",

            transactionDate: payment.createdAt || null,
          };
        })
      );

      return res.status(200).json({
        success: true,
        total: transactions.length,
        data: transactions,
      });
    } catch (error) {
      console.error("Admin Transactions Error:", error);

      return res.status(500).json({
        success: false,
        message: "Failed to fetch transactions.",
      });
    }
  }
);



app.get('/', (req, res) => {
  res.send('Salonbook is server running...')
});



app.listen(port, () => {
  console.log(`salonbook is running on port ${port}`)
})


export default app