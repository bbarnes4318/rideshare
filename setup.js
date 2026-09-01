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
            // The password comes from the environment and is never defaulted.
            //
            // This script used to create admin/password123 and a second
            // analyst/analyst123 account. This dashboard is reachable from the
            // internet and can start batches that submit live leads and spend
            // proxy balance, so a known default password is not something to
            // leave sitting on it - not even briefly, and not with a note asking
            // someone to change it later.
            const password = process.env.ADMIN_PASSWORD;
            const username = process.env.ADMIN_USERNAME || 'admin';
            const email = process.env.ADMIN_EMAIL || 'admin@example.com';

            if (!password) {
                console.error('');
                console.error('❌ No admin user exists and ADMIN_PASSWORD is not set.');
                console.error('');
                console.error('   Create the first account by supplying your own password:');
                console.error("     ADMIN_PASSWORD='your-password' ADMIN_EMAIL=you@example.com npm run setup");
                console.error('');
                console.error('   The password is read from the environment, hashed by the User');
                console.error('   model, and never written to a file or printed here.');
                process.exitCode = 1;
                await mongoose.connection.close();
                return;
            }
            if (String(password).length < 12) {
                console.error('❌ ADMIN_PASSWORD must be at least 12 characters.');
                process.exitCode = 1;
                await mongoose.connection.close();
                return;
            }

            console.log('👤 Creating admin user...');
            const adminUser = new User({ username, email, password, role: 'admin' });
            await adminUser.save();

            console.log('✅ Admin user created.');
            console.log(`   Username: ${username}`);
            console.log(`   Email:    ${email}`);
            console.log('   Password: (the one you supplied; not shown or stored in plaintext)');
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