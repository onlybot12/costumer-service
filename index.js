const express = require("express")
const http = require("http")
const socketIo = require("socket.io")
const path = require("path")

const app = express()
const server = http.createServer(app)
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
})

// Serve static files
app.use(express.static(path.join(__dirname, "public")))

// Add this route after the existing static file serving
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"))
})

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"))
})

app.get("/admin.html", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"))
})

// Store active chats and users
const activeChats = new Map()
const connectedUsers = new Map()
const customerServiceAgents = new Map()

// Chat statistics
const stats = {
  activeChats: 0,
  waitingChats: 0,
  totalChats: 0,
}

io.on("connection", (socket) => {
  console.log("User connected:", socket.id)

  // Handle user joining as customer
  socket.on("join-as-customer", (userData) => {
    const chatId = `chat_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

    // Store user data
    connectedUsers.set(socket.id, {
      ...userData,
      chatId,
      type: "customer",
      socketId: socket.id,
    })

    // Create new chat session
    activeChats.set(chatId, {
      id: chatId,
      customer: connectedUsers.get(socket.id),
      agent: null,
      messages: [],
      status: "waiting",
      createdAt: new Date(),
    })

    // Join chat room
    socket.join(chatId)

    // Update stats
    stats.activeChats++
    stats.totalChats++
    stats.waitingChats++

    // Notify customer service agents about new chat
    socket.to("cs-agents").emit("new-chat", {
      chatId,
      customer: connectedUsers.get(socket.id),
      timestamp: new Date(),
    })

    // Send welcome message
    const welcomeMessage = {
      id: `msg_${Date.now()}`,
      type: "cs",
      text: `Halo ${userData.name}! Selamat datang di SXTream Support. Username Anda: @${userData.username}. Saya siap membantu Anda dengan ${getSubjectText(userData.subject)}. Ada yang bisa saya bantu hari ini?`,
      timestamp: new Date(),
      sender: "System",
    }

    activeChats.get(chatId).messages.push(welcomeMessage)

    socket.emit("chat-started", {
      chatId,
      message: welcomeMessage,
    })

    // Broadcast updated stats
    io.to("cs-agents").emit("stats-update", stats)
  })

  // Handle user joining as customer service agent
  socket.on("join-as-agent", (agentData) => {
    customerServiceAgents.set(socket.id, {
      ...agentData,
      socketId: socket.id,
      status: "online",
    })

    socket.join("cs-agents")

    // Send current chats and stats
    const chatsArray = Array.from(activeChats.values())
    socket.emit("initial-data", {
      chats: chatsArray,
      stats: stats,
    })
  })

  // Handle customer message
  socket.on("customer-message", (data) => {
    const user = connectedUsers.get(socket.id)
    if (!user) return

    const chat = activeChats.get(user.chatId)
    if (!chat) return

    const message = {
      id: `msg_${Date.now()}`,
      type: "user",
      text: data.message,
      timestamp: new Date(),
      sender: user.name,
    }

    chat.messages.push(message)

    // Send to customer service agents
    io.to("cs-agents").emit("new-message", {
      chatId: user.chatId,
      message: message,
    })

    // Echo back to customer
    socket.emit("message-sent", message)
  })

  // Handle agent message
  socket.on("agent-message", (data) => {
    const agent = customerServiceAgents.get(socket.id)
    if (!agent) return

    const chat = activeChats.get(data.chatId)
    if (!chat) return

    const message = {
      id: `msg_${Date.now()}`,
      type: "cs",
      text: data.message,
      timestamp: new Date(),
      sender: agent.name || "Customer Service",
    }

    chat.messages.push(message)

    // Send to customer
    if (chat.customer) {
      io.to(data.chatId).emit("new-message", {
        chatId: data.chatId,
        message: message,
      })
    }

    // Send to other agents
    socket.to("cs-agents").emit("new-message", {
      chatId: data.chatId,
      message: message,
    })
  })

  // Handle agent selecting a chat
  socket.on("select-chat", (data) => {
    const chat = activeChats.get(data.chatId)
    if (!chat) return

    const agent = customerServiceAgents.get(socket.id)
    if (!agent) return

    // Assign agent to chat if not already assigned
    if (!chat.agent) {
      chat.agent = agent
      chat.status = "active"
      stats.waitingChats = Math.max(0, stats.waitingChats - 1)

      io.to("cs-agents").emit("stats-update", stats)
    }

    // Send chat history to agent
    socket.emit("chat-history", {
      chatId: data.chatId,
      messages: chat.messages,
      customer: chat.customer,
    })
  })

  // Handle typing indicators
  socket.on("typing-start", (data) => {
    const user = connectedUsers.get(socket.id)
    const agent = customerServiceAgents.get(socket.id)

    if (user) {
      // Customer typing - notify agents
      io.to("cs-agents").emit("user-typing", {
        chatId: user.chatId,
        userName: user.name,
      })
    } else if (agent && data.chatId) {
      // Agent typing - notify customer
      io.to(data.chatId).emit("agent-typing", {
        chatId: data.chatId,
        agentName: agent.name || "Customer Service",
      })
    }
  })

  socket.on("typing-stop", (data) => {
    const user = connectedUsers.get(socket.id)
    const agent = customerServiceAgents.get(socket.id)

    if (user) {
      io.to("cs-agents").emit("user-typing-stop", {
        chatId: user.chatId,
      })
    } else if (agent && data.chatId) {
      io.to(data.chatId).emit("agent-typing-stop", {
        chatId: data.chatId,
      })
    }
  })

  // Handle chat transfer
  socket.on("transfer-chat", (data) => {
    const chat = activeChats.get(data.chatId)
    if (!chat) return

    const transferMessage = {
      id: `msg_${Date.now()}`,
      type: "system",
      text: `Chat telah ditransfer ke ${data.agentName}`,
      timestamp: new Date(),
      sender: "System",
    }

    chat.messages.push(transferMessage)

    // Notify all parties
    io.to(data.chatId).emit("new-message", {
      chatId: data.chatId,
      message: transferMessage,
    })

    io.to("cs-agents").emit("chat-transferred", {
      chatId: data.chatId,
      message: transferMessage,
    })
  })

  // Handle end chat
  socket.on("end-chat", (data) => {
    const chat = activeChats.get(data.chatId)
    if (!chat) return

    const endMessage = {
      id: `msg_${Date.now()}`,
      type: "system",
      text: "Chat session telah berakhir. Terima kasih telah menggunakan layanan kami.",
      timestamp: new Date(),
      sender: "System",
    }

    chat.messages.push(endMessage)
    chat.status = "ended"

    // Notify customer
    io.to(data.chatId).emit("chat-ended", {
      chatId: data.chatId,
      message: endMessage,
    })

    // Update stats
    stats.activeChats = Math.max(0, stats.activeChats - 1)

    // Remove from active chats after a delay
    setTimeout(() => {
      activeChats.delete(data.chatId)
    }, 30000)

    io.to("cs-agents").emit("stats-update", stats)
    io.to("cs-agents").emit("chat-ended", { chatId: data.chatId })
  })

  // Handle disconnect
  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id)

    // Handle customer disconnect
    const user = connectedUsers.get(socket.id)
    if (user) {
      const chat = activeChats.get(user.chatId)
      if (chat && chat.status !== "ended") {
        chat.status = "customer_disconnected"
        io.to("cs-agents").emit("customer-disconnected", {
          chatId: user.chatId,
        })
      }
      connectedUsers.delete(socket.id)
    }

    // Handle agent disconnect
    const agent = customerServiceAgents.get(socket.id)
    if (agent) {
      customerServiceAgents.delete(socket.id)
      // Notify other agents
      socket.to("cs-agents").emit("agent-disconnected", {
        agentId: socket.id,
      })
    }
  })
})

function getSubjectText(subject) {
  const subjects = {
    api: "pertanyaan API",
    technical: "masalah teknis",
    billing: "billing & pembayaran",
    general: "pertanyaan umum",
  }
  return subjects[subject] || "pertanyaan Anda"
}

const PORT = process.env.PORT || 3000
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})
