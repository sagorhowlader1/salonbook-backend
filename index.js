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
  const db = mongoClient.db("salonbook")



app.get('/', (req, res) => {
    res.send('Salonbook is server running...')
});






app.listen(port, () => {
    console.log(`salonbook is running on port ${port}`)
})