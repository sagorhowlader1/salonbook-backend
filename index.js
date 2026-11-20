import express from 'express';
import cors from 'cors';
import 'dotenv/config'
import { MongoClient, ObjectId } from 'mongodb';

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
const appointmentsCollection = db.collection("appointments")




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


// GET: Customer's Own Appointments

app.get(
  "/appointments/my",
  // verifyInternalRequest,
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
  // verifyInternalRequest,
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
  // verifyInternalRequest,
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




app.get("/service", async (req, res) => {
  try {
    const result = await servicesCollection.find().toArray()
    res.send(result)
  } catch (error) {
    res.status(500).send({
      message: "Failed to fetch services",
    })
  }
})



// Create uploads folder if it doesn't exist
const uploadDir = path.join(process.cwd(), "uploads")

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true })
}

// Multer configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir)
  },

  filename: (req, file, cb) => {
    const extension = path.extname(file.originalname)
    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${extension}`

    cb(null, uniqueName)
  },
})

const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true)
    } else {
      cb(new Error("Only image files are allowed"))
    }
  },
})



// Serve uploaded images
app.use("/uploads", express.static(uploadDir))


// Create service
app.post("/service", upload.single("imageFile"), async (req, res) => {
  try {
    const serviceData = {
      name: req.body.name,
      category: req.body.category,
      description: req.body.description,
      price: Number(req.body.price),
      duration: Number(req.body.duration),
      status: req.body.status,
      image: req.file ? `/uploads/${req.file.filename}` : "",
    }

    const result = await servicesCollection.insertOne(serviceData)

    res.status(201).send({
      message: "Service created successfully",
      insertedId: result.insertedId,
      service: serviceData,
    })
  } catch (error) {
  
    res.status(500).send({
      message: "Service creation failed",
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
      return res.status(400).send({ message: "Invalid service ID" })
    }

    const existingService = servicesCollection.findOne({
      _id: new ObjectId(id),
    })

    if (!existingService) {
      // Remove newly uploaded file if service doesn't exist
      if (req.file) fs.unlinkSync(req.file.path)

      return res.status(404).send({ message: "Service not found" })
    }

    const updatedService = {
      name: req.body.name,
      category: req.body.category,
      description: req.body.description,
      price: Number(req.body.price),
      duration: Number(req.body.duration),
      status: req.body.status,
      image: req.file
        ? `/uploads/${req.file.filename}`
        : existingService.image,
    }

    const result = await servicesCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: updatedService }
    )

    // Remove old image after successful update with a new image
    if (req.file && existingService.image?.startsWith("/uploads/")) {
      const oldFilename = path.basename(existingService.image)
      const oldImagePath = path.join(process.cwd(), "uploads", oldFilename)

      if (fs.existsSync(oldImagePath)) {
        fs.unlinkSync(oldImagePath)
      }
    }

    res.send({
      message: "Service updated successfully",
      modifiedCount: result.modifiedCount,
      service: {
        _id: id,
        ...updatedService,
      },
    })
  } catch (error) {
    console.error("Update service error:", error)

    // Clean up uploaded file if update fails
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path)
    }

    res.status(500).send({ message: "Failed to update service" })
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



app.get('/', (req, res) => {
    res.send('Salonbook is server running...')
});




app.listen(port, () => {
    console.log(`salonbook is running on port ${port}`)
})


export default app