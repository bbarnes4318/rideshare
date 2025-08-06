const mongoose = require('mongoose');
const User = require('./models/User');
require('dotenv').config();

async function setupDatabase() {
    try {
        // Connect to MongoDB
        console.log('🔗 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGODB_URI, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
        });
        console.log('✅ Connected to MongoDB');
        
        // Check if admin user already exists
        const existingAdmin = await User.findOne({ role: 'admin' });
        
        if (existingAdmin) {
            console.log('⚠️  Admin user already exists:');
            console.log(`   Username: ${existingAdmin.username}`);
            console.log(`   Email: ${existingAdmin.email}`);
        } else {
            // Create default admin user
            console.log('👤 Creating default admin user...');
            
            const adminUser = new User({
                username: 'admin',
                email: 'admin@perenroll.com',
                password: 'password123', // This will be hashed automatically
                role: 'admin'
            });
            
            await adminUser.save();
            
            console.log('✅ Admin user created successfully!');
            console.log('📝 Default credentials:');
            console.log('   Username: admin');
            console.log('   Password: password123');
            console.log('   Email: admin@perenroll.com');
            console.log('');
            console.log('⚠️  IMPORTANT: Please change the default password after first login!');
        }
        
        // Create additional sample users if needed
        const analystExists = await User.findOne({ role: 'analyst', username: 'analyst' });
        if (!analystExists) {
            const analystUser = new User({
                username: 'analyst',
                email: 'analyst@perenroll.com',
                password: 'analyst123',
                role: 'analyst'
            });
            
            await analystUser.save();
            console.log('✅ Sample analyst user created (analyst/analyst123)');
        }
        
        // Display database info
        const userCount = await User.countDocuments();
        console.log('');
        console.log('📊 Database Status:');
        console.log(`   Total users: ${userCount}`);
        
        console.log('');
        console.log('🚀 Setup complete! You can now:');
        console.log('   1. Start the server: npm start');
        console.log('   2. Visit the landing page: http://localhost:5000/');
        console.log('   3. Access the dashboard: http://localhost:5000/admin');
        console.log('   4. View analytics: http://localhost:5000/dashboard');
        
    } catch (error) {
        console.error('❌ Setup failed:', error);
        process.exit(1);
    } finally {
        await mongoose.disconnect();
        console.log('👋 Disconnected from MongoDB');
        process.exit(0);
    }
}

// Run setup if called directly
if (require.main === module) {
    setupDatabase();
}

module.exports = { setupDatabase };