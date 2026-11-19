import express from 'express';
import cors from 'cors';
import 'dotenv/config'
import { MongoClient } from 'mongodb';

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



app.get('/service', async(req, res)=> {
  const result = await servicesCollection.find().toArray()
  res.send(result)
})


app.post('/service', async (req, res) => {
  try {
    const data = req.body

    console.log("Received Service Data:", data)

    const result = await servicesCollection.insertOne(data)

    res.send({
      success: true,
      message: "Service created successfully",
      insertedId: result.insertedId,
      service: {
        ...data,
        _id: result.insertedId,
      },
    })
  } catch (error) {
    res.status(500).send({
      success: false,
      message: "Failed to create service",
    })
  }
})


// app.post('/service', async(req, res) => {
//   const data = req.body
//   const result = await servicesCollection.insertOne(data)
//   console.log(result)
//   res.send(result)
// })
 



app.get('/', (req, res) => {
    res.send('Salonbook is server running...')
});






app.listen(port, () => {
    console.log(`salonbook is running on port ${port}`)
})