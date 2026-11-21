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
  // verifyInternalRequest,
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


// app.get("/service", async (req, res) => {
//   try {
//     const result = await servicesCollection.find().toArray()
//     res.send(result)
//   } catch (error) {
//     res.status(500).send({
//       message: "Failed to fetch services",
//     })
//   }
// })






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



// payments related apis
app.post('/payments/chechout-verify', async (req, res) => {
  const { sessionId } = req.body;
  
  if(!sessionId){
    return res.send({ success: false, message: 'Session ID is required!'});
  }


  const {
    status,
    payment_status,
    customer_email,
    metadata,
    payment_intent,

  } = await stripe.checkout.sessions.retrieve(sessionId);

  // 1. is used new session
  // 2. check is the session id for the currently logged in user
  // 3. insert sessionId into the payments collectin
  // 4. update user information as premium user

  if (status === 'complete' && payment_status === 'paid') {

    const sessionQuery = { sessionId };
    const existingPayment = await paymentsCollection.findOne(sessionQuery);
    if(existingPayment) {
      return res.send({success: false, message: 'Payment already verified.' })
    }

    const payment = {
      sessionId,
      status,
      payment_status,
      customer_email,
      userId: metadata.userId,
      payment_intent,
    }

    const result = await paymentsCollection.insertOne(payment);

    const query = {_id: new ObjectId(metadata.userId) };

    const updateDoc = {
      $set: {
        premium: true,
      }
    }
    const updateResult = await usersCollection.updateOne(
      query,
      updateDoc
    );
    res.send({success: true, result, updateResult});
    return
  }

  res.send({success: false, message: 'Payment verification failed!'});
})


app.get('/', (req, res) => {
  res.send('Salonbook is server running...')
});




app.listen(port, () => {
  console.log(`salonbook is running on port ${port}`)
})


export default app