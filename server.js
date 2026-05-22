const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { WebcastPushConnection } = require("tiktok-live-connector");
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcrypt");
const session = require("express-session");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const ADMIN_EMAIL = "azad2hesab@gmail.com";

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
  secret: "azad-overlay-secret",
  resave: false,
  saveUninitialized: false
}));

app.use(express.static(__dirname));

const db = new sqlite3.Database("./database.db");

db.run(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE,
    password TEXT,
    tiktok_username TEXT
  )
`);

app.post("/register", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.json({ success: false, message: "Email və parol yaz." });
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  db.run(
    "INSERT INTO users (email, password) VALUES (?, ?)",
    [email, hashedPassword],
    function(err) {
      if (err) {
        return res.json({ success: false, message: "Bu email artıq istifadə olunub." });
      }

      req.session.userId = this.lastID;
      res.json({ success: true });
    }
  );
});

app.post("/login", (req, res) => {
  const { email, password } = req.body;

  db.get("SELECT * FROM users WHERE email = ?", [email], async (err, user) => {
    if (!user) {
      return res.json({ success: false, message: "Email və ya parol yanlışdır." });
    }

    const match = await bcrypt.compare(password, user.password);

    if (!match) {
      return res.json({ success: false, message: "Email və ya parol yanlışdır." });
    }

    req.session.userId = user.id;
    res.json({ success: true });
  });
});

app.post("/save-username", (req, res) => {
  if (!req.session.userId) {
    return res.json({ success: false, message: "Login ol." });
  }

  const username = String(req.body.username || "").replace("@", "").trim();

  db.run(
    "UPDATE users SET tiktok_username = ? WHERE id = ?",
    [username, req.session.userId],
    () => res.json({ success: true, username })
  );
});

app.get("/me", (req, res) => {
  if (!req.session.userId) {
    return res.json({ loggedIn: false });
  }

  db.get(
    "SELECT id, email, tiktok_username FROM users WHERE id = ?",
    [req.session.userId],
    (err, user) => res.json({ loggedIn: true, user })
  );
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login.html");
  });
});

function requireAdmin(req, res, next) {
  if (!req.session.userId) {
    return res.json({ success: false, message: "Login ol." });
  }

  db.get("SELECT * FROM users WHERE id = ?", [req.session.userId], (err, user) => {
    if (!user || user.email !== ADMIN_EMAIL) {
      return res.json({ success: false, message: "Admin icazəsi yoxdur." });
    }

    next();
  });
}

app.get("/admin-data", requireAdmin, (req, res) => {
  db.all(
    "SELECT id, email, tiktok_username FROM users ORDER BY id DESC",
    [],
    (err, users) => {
      if (err) {
        return res.json({ success: false, message: "Database xətası." });
      }

      res.json({
        success: true,
        totalUsers: users.length,
        users
      });
    }
  );
});

const liveRooms = {};

function getAvatar(data) {
  return (
    data.profilePictureUrl ||
    data.user?.profilePictureUrl ||
    data.user?.avatarThumb ||
    data.user?.avatarMedium ||
    data.user?.avatarLarger ||
    ""
  );
}

function getDiamondCount(data, giftName) {
  let count = Number(
    data.diamondCount ||
    data.gift?.diamond_count ||
    data.gift?.diamondCount ||
    data.giftDetails?.diamondCount ||
    0
  );

  const name = String(giftName || "").toLowerCase();

  if (!count || count <= 1) {
    if (name.includes("universe") || name.includes("universal")) count = 44999;
    else if (name.includes("lion")) count = 29999;
    else if (name.includes("castle")) count = 20000;
    else if (name.includes("rocket")) count = 20000;
    else if (name.includes("planet")) count = 15000;
    else count = 1;
  }

  return count;
}

function getRepeatCount(data) {
  return Number(data.repeatCount || data.repeat_count || 1);
}

function createLiveRoom(username) {
  if (liveRooms[username]) {
    return liveRooms[username];
  }

  const room = {
    username,
    connection: new WebcastPushConnection(username),
    gifters: {},
    processedGifts: new Set(),
    stats: {
      viewers: 0,
      likes: 0,
      shares: 0,
      topGifters: []
    }
  };

  function updateTopGifters() {
    room.stats.topGifters = Object.values(room.gifters)
      .sort((a, b) => b.total - a.total)
      .slice(0, 5);

    io.to(username).emit("topGifters", room.stats.topGifters);
  }

  room.connection.connect()
    .then(() => {
      console.log("TikTok LIVE qoşuldu:", username);
      io.to(username).emit("status", "LIVE qoşuldu");
    })
    .catch(err => {
      console.log("Xəta:", username, err.message);
      io.to(username).emit("status", "LIVE qoşulmadı və ya username səhvdir.");
    });

  room.connection.on("gift", data => {
    const userId = String(data.userId || data.uniqueId || data.nickname || "unknown");
    const nickname = data.nickname || data.uniqueId || "User";
    const giftName = data.giftName || data.gift?.name || "Gift";
    const repeatCount = getRepeatCount(data);
    const diamondCount = getDiamondCount(data, giftName);
    const avatar = getAvatar(data);

    const giftValue = diamondCount * repeatCount;

    const giftKey = [
      userId,
      giftName,
      repeatCount,
      diamondCount,
      data.msgId || data.giftId || data.timestamp || data.createTime || Date.now()
    ].join("_");

    if (room.processedGifts.has(giftKey)) return;

    room.processedGifts.add(giftKey);

    if (room.processedGifts.size > 5000) {
      room.processedGifts.clear();
    }

    if (!room.gifters[userId]) {
      room.gifters[userId] = {
        userId,
        nickname,
        avatar,
        total: 0,
        gifts: 0
      };
    }

    room.gifters[userId].nickname = nickname;
    room.gifters[userId].avatar = avatar || room.gifters[userId].avatar;
    room.gifters[userId].total += giftValue;
    room.gifters[userId].gifts += repeatCount;

    updateTopGifters();

    io.to(username).emit("gift", {
      text: `${nickname} göndərdi: ${giftName} x${repeatCount}`,
      userId,
      nickname,
      giftName,
      repeatCount,
      diamondCount,
      giftValue
    });
  });

  room.connection.on("like", data => {
    room.stats.likes += Number(data.likeCount || 1);
    io.to(username).emit("likes", room.stats.likes);
  });

  room.connection.on("share", () => {
    room.stats.shares += 1;
    io.to(username).emit("shares", room.stats.shares);
  });

  room.connection.on("roomUser", data => {
    room.stats.viewers = Number(data.viewerCount || 0);
    io.to(username).emit("viewers", room.stats.viewers);
  });

  liveRooms[username] = room;
  return room;
}

io.on("connection", socket => {
  socket.on("joinLive", username => {
    username = String(username || "").replace("@", "").trim();

    if (!username) return;

    socket.join(username);

    const room = createLiveRoom(username);
    socket.emit("init", room.stats);
  });
});

server.listen(3000, "0.0.0.0", () => {
  console.log("Server açıldı:");
  console.log("Panel: http://localhost:3000/index.html");
});