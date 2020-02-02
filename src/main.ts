require("dotenv").config()
import * as asyncHandler from "express-async-handler"
import { MongoClient } from "mongodb"
import * as express from "express"
import * as cors from "cors"
import * as crypto from "crypto"
import fetch from "node-fetch"

const PORT = +process.env.PORT!

async function main() {
  const app = express()
  app.use(cors())

  const mongoClient = await MongoClient.connect("mongodb://localhost:27017", { useUnifiedTopology: true })
  const db = mongoClient.db("loopover")

  const users = await db.createCollection("users")
  const solves = await db.createCollection("solves")
  const sessions = await db.createCollection("sessions")

  solves.createIndex({ event: 1, user: 1, startTime: -1 })
  sessions.createIndex({ token: 1 })

  app.post("/authenticate/google", asyncHandler(async (req, res) => {
    let response = await fetch(`https://oauth2.googleapis.com/token?${new URLSearchParams({
      grant_type: "authorization_code",
      code: req.query.code,
      redirect_uri: req.query.redirect_uri
    })}`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${process.env.GOOGLE_CLIENT_ID}:${process.env.GOOGLE_CLIENT_SECRET}`).toString("base64")}`
      }
    })

    if (!response.ok) throw new Error(response.statusText)
    const token = await response.json()

    response = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${token.access_token}` }
    })

    if (!response.ok) throw new Error(response.statusText)
    const userinfo = await response.json()

    const user = (await users.findOneAndReplace({ provider: "google", uid: userinfo.sub }, {
      name: userinfo.name,
      provider: "google",
      uid: userinfo.sub,
      avatarUrl: userinfo.picture,
      access_token: token.access_token,
      refresh_token: token.refresh_token
    }, { upsert: true })).value

    const cookieToken = crypto.randomBytes(16).toString("base64")
    sessions.insertOne({ token: cookieToken, user: user._id })

    res.json({
      name: user.name,
      avatarUrl: user.avatarUrl,
      token: cookieToken
    })
  }))

  app.post("/authenticate/discord", asyncHandler(async (req, res) => {
    let response = await fetch(`https://discordapp.com/api/oauth2/token?${new URLSearchParams({
      grant_type: "authorization_code",
      code: req.query.code,
      redirect_uri: req.query.redirect_uri
    })}`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${process.env.DISCORD_CLIENT_ID}:${process.env.DISCORD_CLIENT_SECRET}`).toString("base64")}`
      }
    })

    if (!response.ok) throw new Error(response.statusText)
    const token = await response.json()

    response = await fetch("https://discordapp.com/api/users/@me", {
      headers: { Authorization: `Bearer ${token.access_token}` }
    })

    if (!response.ok) throw new Error(response.statusText)
    const me = await response.json()

    const user = (await users.findOneAndReplace({ provider: "discord", uid: me.id }, {
      name: `${me.username}#${me.discriminator}`,
      provider: "discord",
      uid: me.id,
      avatarUrl: me.avatar
        ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png`
        : `https://cdn.discordapp.com/embed/avatars/${me.discriminator % 5}.png`,
      access_token: token.access_token,
      refresh_token: token.refresh_token
    }, { upsert: true })).value

    const cookieToken = crypto.randomBytes(16).toString("base64")
    sessions.insertOne({ token: cookieToken, user: user._id })

    res.json({
      name: user.name,
      avatarUrl: user.avatarUrl,
      token: cookieToken
    })
  }))

  app.use((req, res, next) => {
    let match: RegExpMatchArray | null
    if (match = (req.headers.authorization || "").match(/^Bearer (.+)/)) {
      sessions.findOne({ token: match[1] }).then(session => {
        if (!session) return res.status(401).end()
        sessions.updateOne({ token: match![1] }, { $set: { lastUsed: Date.now() } })
        res.locals.token = session.token
        res.locals.uid = session.user
        next()
      }).catch(next)
    } else {
      res.status(401).end()
    }
  })

  app.get("/me", asyncHandler(async (_req, res) => {
    const user = await users.findOne({ _id: res.locals.uid })
    res.json({
      name: user.name,
      avatarUrl: user.avatarUrl
    })
  }))

  app.use(express.json({ limit: 1024 * 512 }))

  app.post("/sync", asyncHandler(async (req, res) => {
    const allSolves = await solves.find({ user: res.locals.uid }).toArray()

    const solveIds = new Set<number>(req.body)
    const sendSolves: any[] = []

    for (const solve of allSolves) {
      if (solveIds.has(solve.startTime)) {
        solveIds.delete(solve.startTime)
      } else {
        sendSolves.push({ ...solve, _id: undefined, user: undefined })
      }
    }

    res.json({ missing: [...solveIds], solves: sendSolves })
  }))

  app.put("/sync", asyncHandler(async (req, res) => {
    for (const solve of req.body) {
      if (solve._id != null) return res.status(400).end()
      if (typeof solve.startTime != "number") return res.status(400).end()
    }

    solves.insertMany(req.body.map((solve: any) => ({ ...solve, user: res.locals.uid })))
    res.end()
  }))

  app.delete("/sync", asyncHandler(async (req, res) => {
    if (!(req.body instanceof Array)) return res.status(400).end()
    await solves.deleteMany({ user: res.locals.uid, startTime: { $in: req.body } })
    res.end()
  }))

  app.listen(PORT)
}

main()
